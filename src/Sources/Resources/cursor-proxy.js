#!/usr/bin/env node

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const { exec } = require('child_process');

const PORT = 8319;
const TARGET_HOST = 'api2.cursor.sh';
const TARGET_PORT = 443;
// Match Cursor.app so api2.cursor.sh treats all proxied requests (Droid CLI, AMP, etc.) as IDE requests
const CLIENT_VERSION = '2.5.8';  // fallback; can be overridden by reading Cursor.app product.json

// ─────────────────────────────────────────────
//  Minimal Protobuf Codec (no external deps)
// ─────────────────────────────────────────────

function pbVarint(n) {
    n = n >>> 0;
    const bytes = [];
    do {
        let b = n & 0x7f;
        n >>>= 7;
        if (n) b |= 0x80;
        bytes.push(b);
    } while (n);
    return Buffer.from(bytes);
}

function pbTag(field, wire) { return pbVarint((field << 3) | wire); }

function pbString(field, str) {
    const buf = Buffer.from(str, 'utf8');
    return Buffer.concat([pbTag(field, 2), pbVarint(buf.length), buf]);
}

function pbMsg(field, inner) {
    return Buffer.concat([pbTag(field, 2), pbVarint(inner.length), inner]);
}

function pbBool(field, val) {
    return Buffer.concat([pbTag(field, 0), pbVarint(val ? 1 : 0)]);
}

function pbEnum(field, val) {
    return Buffer.concat([pbTag(field, 0), pbVarint(val)]);
}

function readVarint(buf, off) {
    let val = 0, shift = 0, pos = off;
    while (pos < buf.length) {
        const b = buf[pos++];
        val |= (b & 0x7f) << shift;
        shift += 7;
        if (!(b & 0x80)) break;
        if (shift > 35) break;
    }
    return { v: val >>> 0, n: pos - off };
}

function pbDecode(buf) {
    const fields = [];
    let off = 0;
    while (off < buf.length) {
        const t = readVarint(buf, off);
        if (t.n === 0) break;
        off += t.n;
        const fn = t.v >>> 3, wt = t.v & 7;
        if (wt === 0) {
            const v = readVarint(buf, off);
            off += v.n;
            fields.push({ f: fn, w: wt, v: v.v });
        } else if (wt === 2) {
            const len = readVarint(buf, off);
            off += len.n;
            if (off + len.v > buf.length) break;
            fields.push({ f: fn, w: wt, v: buf.slice(off, off + len.v) });
            off += len.v;
        } else if (wt === 1) { off += 8; }
        else if (wt === 5) { off += 4; }
        else break;
    }
    return fields;
}

// ─────────────────────────────────────────────
//  Connect Protocol helpers
// ─────────────────────────────────────────────

function connectEnvelope(payload) {
    const hdr = Buffer.alloc(5);
    hdr.writeUInt8(0, 0);                    // flags=0 (uncompressed)
    hdr.writeUInt32BE(payload.length, 1);
    return Buffer.concat([hdr, payload]);
}

function connectParseFrames(buf) {
    const frames = [];
    let off = 0;
    while (off + 5 <= buf.length) {
        const flags = buf.readUInt8(off);
        const len = buf.readUInt32BE(off + 1);
        off += 5;
        if (off + len > buf.length) { off -= 5; break; }
        frames.push({ flags, data: buf.slice(off, off + len) });
        off += len;
    }
    return { frames, rest: buf.slice(off) };
}

// ─────────────────────────────────────────────
//  Protobuf Message Builders for Cursor API
// ─────────────────────────────────────────────

// ConversationMessage { text(1 string), type(2 enum), bubble_id(13 string) }
function mkConvMsg(text, role) {
    const type = role === 'assistant' ? 2 : (role === 'system' ? 1 : 1); // HUMAN=1, AI=2
    return Buffer.concat([
        pbString(1, text),
        pbEnum(2, type),
        pbString(13, crypto.randomUUID()),
    ]);
}

// ModelDetails { model_name(1 string) }
function mkModelDetails(model) { return pbString(1, model); }

// StreamUnifiedChatRequest:
//   conversation(1 repeated msg), model_details(5 msg), is_chat(22 bool),
//   conversation_id(23 string), is_agentic(27 bool)
function mkStreamUnifiedChatRequest(messages, model, conversationId) {
    const parts = [];
    for (const m of messages) {
        const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        parts.push(pbMsg(1, mkConvMsg(text, m.role)));
    }
    parts.push(pbMsg(5, mkModelDetails(model)));
    parts.push(pbBool(22, true));                   // is_chat
    parts.push(pbString(23, conversationId));        // conversation_id
    parts.push(pbBool(27, false));                   // is_agentic
    return Buffer.concat(parts);
}

// ─────────────────────────────────────────────
//  Response Parsing
// ─────────────────────────────────────────────

// StreamUnifiedChatResponse { text(1 string) }
function extractText(protobuf) {
    let text = '';
    for (const f of pbDecode(protobuf)) {
        if (f.f === 1 && f.w === 2) text += f.v.toString('utf8');
    }
    return text;
}

// Decode a single Connect frame payload (handling gzip)
function decodeFramePayload(frame) {
    if (frame.flags & 0x02) return null;  // trailer frame
    let payload = frame.data;
    if (frame.flags & 0x01) {
        try { payload = zlib.gunzipSync(payload); }
        catch (e) { console.error('gunzip error:', e.message); return null; }
    }
    return payload;
}

function decodeConnectFrameData(frame) {
    // Like decodeFramePayload, but supports trailers too (Cursor often gzip-compresses trailers).
    let payload = frame.data;
    if (frame.flags & 0x01) {
        try { payload = zlib.gunzipSync(payload); }
        catch (e) { return null; }
    }
    return payload;
}

// Get Cursor token from request or fallback to file-based auth
function getCursorToken(req) {
    // First try to get from Authorization header (Factory-Droid CLI sends API key here)
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        if (token && token !== 'dummy-cursor-token') {
            return token;
        }
    }

    // Fallback to file-based auth for compatibility
    const authDir = path.join(os.homedir(), '.cli-proxy-api');
    try {
        const files = fs.readdirSync(authDir);
        for (const file of files) {
            if (file.startsWith('cursor-') && file.endsWith('.json')) {
                const content = fs.readFileSync(path.join(authDir, file), 'utf8');
                const data = JSON.parse(content);
                return data.api_key; // JWT access token
            }
        }
    } catch (err) {
        console.error('Failed to read Cursor token:', err.message);
    }
    return null;
}

// Prefer Cursor.app version from product.json so we stay in sync with the real IDE
function getCursorAppVersion() {
    const productPath = path.join(os.homedir(), 'Library/Application Support/Cursor/product.json');
    const bundledPath = '/Applications/Cursor.app/Contents/Resources/app/product.json';
    for (const p of [productPath, bundledPath]) {
        try {
            if (fs.existsSync(p)) {
                const data = JSON.parse(fs.readFileSync(p, 'utf8'));
                if (data && data.version) return data.version;
            }
        } catch (_) { /* ignore */ }
    }
    return CLIENT_VERSION;
}

// Get machine ID from Cursor's SQLite database via CLI or fallback to hash
function getMachineId(token, callback) {
    // Try to read from Cursor's state.vscdb
    const dbPath = path.join(os.homedir(), 'Library/Application Support/Cursor/User/globalStorage/state.vscdb');

    if (fs.existsSync(dbPath)) {
        // Use sqlite3 CLI to avoid node-gyp/native module dependencies
        exec(`sqlite3 "${dbPath}" "SELECT value FROM ItemTable WHERE key = 'storage.serviceMachineId'"`, (error, stdout, stderr) => {
            if (error || !stdout || stdout.trim() === '') {
                // Fallback to hash if CLI fails or no result
                return callback(generateMachineIdFallback(token));
            }
            callback(stdout.trim());
        });
    } else {
        // Fallback: generate from token hash
        callback(generateMachineIdFallback(token));
    }
}

function generateMachineIdFallback(token) {
    return crypto.createHash('sha256').update(token + 'machineId').digest('hex');
}

// Generate Cursor checksum using Jyh cipher + machine ID
function generateCursorChecksum(machineId) {
    const timestamp = Math.floor(Date.now() / 1000000); // milliseconds / 1000000

    // Convert timestamp to 6-byte array
    const byteArray = new Uint8Array([
        (timestamp >> 40) & 0xFF,
        (timestamp >> 32) & 0xFF,
        (timestamp >> 24) & 0xFF,
        (timestamp >> 16) & 0xFF,
        (timestamp >> 8) & 0xFF,
        timestamp & 0xFF
    ]);

    // Apply Jyh cipher obfuscation
    let key = 165;
    for (let i = 0; i < byteArray.length; i++) {
        byteArray[i] = ((byteArray[i] ^ key) + i) & 0xFF;
        key = byteArray[i];
    }

    // URL-safe base64 encode
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let encoded = '';
    for (let i = 0; i < byteArray.length; i += 3) {
        const a = byteArray[i];
        const b = i + 1 < byteArray.length ? byteArray[i + 1] : 0;
        const c = i + 2 < byteArray.length ? byteArray[i + 2] : 0;

        encoded += alphabet[a >> 2];
        encoded += alphabet[((a & 3) << 4) | (b >> 4)];
        if (i + 1 < byteArray.length) {
            encoded += alphabet[((b & 15) << 2) | (c >> 6)];
        }
        if (i + 2 < byteArray.length) {
            encoded += alphabet[c & 63];
        }
    }

    return encoded + machineId;
}

// Cache for machine ID (fetched once at startup)
let cachedMachineId = null;

const server = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
        return;
    }

    const token = getCursorToken(req);
    if (!token) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Cursor token not configured - please ensure you are logged into Cursor.app or provide a valid API key');
        return;
    }

    // Get machine ID (async, cached after first fetch)
    const handleRequest = (machineId) => {
        const checksum = generateCursorChecksum(machineId);
        const version = getCursorAppVersion();

        // Translate OpenAI-style requests to Cursor protocol
        let cursorPath = req.url;
        let isOpenAIRequest = false;

        if (cursorPath.startsWith('/v1/')) {
            cursorPath = cursorPath.substring(3); // Remove /v1 prefix
            isOpenAIRequest = true;
        }

        // Handle OpenAI chat completions for both styles:
        // 1) /v1/chat/completions (base_url includes /v1)
        // 2) /chat/completions (base_url is plain host:port)
        if (cursorPath === '/chat/completions') {
            return handleOpenAIChatCompletion(req, res, token, checksum, version);
        }
        if (cursorPath === '/responses') {
            return handleOpenAIResponses(req, res, token, checksum, version);
        }

        console.log(`Cursor request: token=${token ? 'present' : 'missing'}, path=${cursorPath}, checksum=${checksum.substring(0, 10)}...`);

        // Build Cursor API headers so api2.cursor.sh sees every request as Cursor.app (IDE)
        // Use Connect protocol with proper headers like chatgpt-adapter
        const options = {
            hostname: TARGET_HOST,
            port: TARGET_PORT,
            path: cursorPath,
            method: req.method,
            headers: {
                'host': TARGET_HOST,
                'authorization': `Bearer ${token}`,
                'content-type': 'application/connect+proto',
                'connect-accept-encoding': 'gzip',
                'connect-content-encoding': 'gzip',
                'connect-protocol-version': '1',
                'x-cursor-client-version': version,
                'x-cursor-client-type': 'ide',
                'x-cursor-client-os': 'darwin',
                'x-cursor-client-arch': process.arch === 'arm64' ? 'arm64' : 'x86_64',
                'x-cursor-client-device-type': 'desktop',
                'x-cursor-checksum': checksum,
                'x-ghost-mode': 'true',
                'user-agent': 'connect-es/1.6.1', // Use Connect client user agent
                'x-amzn-trace-id': `Root=${require('crypto').randomUUID()}`,
                'traceparent': `00-${require('crypto').randomUUID().replace(/-/g, '')}-${Math.random().toString(16).substr(2, 16)}-00`
            }
        };
        if (req.headers['accept']) {
            options.headers['accept'] = req.headers['accept'];
        }
        if (req.headers['accept-language']) {
            options.headers['accept-language'] = req.headers['accept-language'];
        }
        // Copy connect/gRPC headers if present, but never forward client-type/version/checksum
        const skip = new Set(['host', 'authorization', 'content-type', 'content-length', 'accept-encoding', 'user-agent',
            'x-cursor-client-version', 'x-cursor-client-type', 'x-cursor-client-os', 'x-cursor-client-arch',
            'x-cursor-client-device-type', 'x-cursor-checksum', 'x-ghost-mode']);
        for (const [k, v] of Object.entries(req.headers)) {
            const lower = k.toLowerCase();
            if (v != null && !skip.has(lower)) options.headers[lower] = v;
        }

        const proxy = https.request(options, (proxyRes) => {
            console.log(`Cursor API response: ${proxyRes.statusCode}`);
            if (proxyRes.statusCode !== 200) {
                console.log('Cursor API error headers:', proxyRes.headers);
            }
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
        });

        proxy.on('error', (err) => {
            console.error('Proxy error:', err.message);
            console.error('Proxy error code:', err.code);
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end(`Bad Gateway: ${err.message}`);
        });

        req.pipe(proxy);
    };

    // Use cached machine ID or fetch it
    if (cachedMachineId) {
        handleRequest(cachedMachineId);
    } else {
        getMachineId(token, (machineId) => {
            if (!machineId) {
                console.error('Failed to get machine ID, using fallback');
                machineId = generateMachineIdFallback(token);
            }
            cachedMachineId = machineId;
            handleRequest(machineId);
        });
    }
});

// ─────────────────────────────────────────────
//  Cursor API: StreamUnifiedChat
// ─────────────────────────────────────────────

function cursorStreamChat(proto, token, checksum, version) {
    return new Promise((resolve) => {
        const body = connectEnvelope(proto);
        const req = https.request({
            hostname: TARGET_HOST,
            port: TARGET_PORT,
            path: '/aiserver.v1.ChatService/StreamUnifiedChat',
            method: 'POST',
            headers: {
                'host': TARGET_HOST,
                'authorization': `Bearer ${token}`,
                'content-type': 'application/connect+proto',
                'connect-accept-encoding': 'gzip',
                'connect-protocol-version': '1',
                'x-cursor-client-version': version,
                'x-cursor-client-type': 'ide',
                'x-cursor-client-os': 'darwin',
                'x-cursor-client-arch': process.arch === 'arm64' ? 'arm64' : 'x86_64',
                'x-cursor-client-device-type': 'desktop',
                'x-cursor-checksum': checksum,
                'x-ghost-mode': 'true',
                'user-agent': 'connect-es/1.6.1',
                'x-amzn-trace-id': `Root=${crypto.randomUUID()}`,
                'content-length': body.length,
            }
        }, (res) => {
            console.log(`Cursor StreamUnifiedChat response: ${res.statusCode}`);
            resolve(res);
        });
        req.on('error', (err) => {
            console.error('cursorStreamChat error:', err.message);
            resolve(null);
        });
        req.setTimeout(60000, () => {
            console.error('cursorStreamChat timeout');
            req.destroy();
            resolve(null);
        });
        req.end(body);
    });
}

function cursorStartStreamUnifiedChatWithToolsPoll(requestId, token, checksum, version) {
    return new Promise((resolve) => {
        // BidiPollRequest { request_id(1 msg), start_request(2 bool) }
        const pollProto = Buffer.concat([
            pbMsg(1, pbString(1, requestId)),
            pbBool(2, true),
        ]);
        const body = connectEnvelope(pollProto);

        const req = https.request({
            hostname: TARGET_HOST,
            port: TARGET_PORT,
            path: '/aiserver.v1.ChatService/StreamUnifiedChatWithToolsPoll',
            method: 'POST',
            headers: {
                'host': TARGET_HOST,
                'authorization': `Bearer ${token}`,
                'content-type': 'application/connect+proto',
                'connect-accept-encoding': 'gzip',
                'connect-protocol-version': '1',
                'x-cursor-client-version': version,
                'x-cursor-client-type': 'ide',
                'x-cursor-client-os': 'darwin',
                'x-cursor-client-arch': process.arch === 'arm64' ? 'arm64' : 'x86_64',
                'x-cursor-client-device-type': 'desktop',
                'x-cursor-checksum': checksum,
                'x-ghost-mode': 'true',
                'user-agent': 'connect-es/1.6.1',
                'content-length': body.length,
            }
        }, (res) => resolve(res));

        req.on('error', (err) => {
            console.error('cursorStartPoll error:', err.message);
            resolve(null);
        });
        req.setTimeout(15000, () => {
            console.error('cursorStartPoll timeout');
            req.destroy();
            resolve(null);
        });
        req.end(body);
    });
}

function cursorBidiAppendHex(requestId, dataHex, token, checksum, version) {
    return new Promise((resolve) => {
        // BidiAppendRequest { data(1 string hex), request_id(2 msg), append_seqno(3 int64) }
        // Cursor encodes `data` as a hex string (see cursor-tap debug_bidi tooling).
        const bidiProto = Buffer.concat([
            pbString(1, dataHex),
            pbMsg(2, pbString(1, requestId)),
            pbEnum(3, 0),
        ]);

        const req = https.request({
            hostname: TARGET_HOST,
            port: TARGET_PORT,
            path: '/aiserver.v1.BidiService/BidiAppend',
            method: 'POST',
            headers: {
                'host': TARGET_HOST,
                'authorization': `Bearer ${token}`,
                'content-type': 'application/proto',
                'x-cursor-client-version': version,
                'x-cursor-client-type': 'ide',
                'x-cursor-client-os': 'darwin',
                'x-cursor-client-arch': process.arch === 'arm64' ? 'arm64' : 'x86_64',
                'x-cursor-client-device-type': 'desktop',
                'x-cursor-checksum': checksum,
                'x-ghost-mode': 'true',
                'user-agent': 'connect-es/1.6.1',
                'content-length': bidiProto.length,
            }
        }, (res) => {
            // Consume body so the socket can be reused.
            res.on('data', () => { /* ignore */ });
            res.on('end', () => resolve(res.statusCode || 0));
        });

        req.on('error', (err) => {
            console.error('cursorBidiAppend error:', err.message);
            resolve(0);
        });
        req.setTimeout(15000, () => {
            console.error('cursorBidiAppend timeout');
            req.destroy();
            resolve(0);
        });
        req.end(bidiProto);
    });
}

function parseCursorPollDataToText(dataStr) {
    // BidiPollResponse.data is a string; Cursor appears to send hex for protobuf payloads.
    if (!dataStr) return '';
    if (!/^[0-9a-f]+$/i.test(dataStr) || (dataStr.length % 2) !== 0) return '';
    const bytes = Buffer.from(dataStr, 'hex');

    // Expect StreamUnifiedChatResponseWithTools, where:
    //   field 2 = stream_unified_chat_response (StreamUnifiedChatResponse)
    let text = '';
    for (const f of pbDecode(bytes)) {
        if (f.f === 2 && f.w === 2) {
            text += extractText(f.v);
        }
    }
    return text;
}

async function cursorChatWithToolsPoll(messages, model, token, checksum, version, onTextDelta) {
    const requestId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();

    // StreamUnifiedChatRequestWithTools { stream_unified_chat_request(1) }
    const chatReq = mkStreamUnifiedChatRequest(messages, model, conversationId);
    const toolsReq = pbMsg(1, chatReq);
    const dataHex = toolsReq.toString('hex');

    // Fire append in parallel to avoid any server-side ordering quirks (some deployments won't
    // start poll stream until the first append is present).
    const appendPromise = cursorBidiAppendHex(requestId, dataHex, token, checksum, version);

    const pollResPromise = cursorStartStreamUnifiedChatWithToolsPoll(requestId, token, checksum, version);
    const pollRes = await Promise.race([
        pollResPromise,
        new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
    ]);
    if (!pollRes) {
        // Ensure we don't leak the append request.
        await appendPromise;
        return { ok: false, error: 'poll_no_response' };
    }
    if (pollRes.statusCode !== 200) {
        await appendPromise;
        return { ok: false, error: `poll_http_${pollRes.statusCode}` };
    }

    await appendPromise;

    return await new Promise((resolve) => {
        let buf = Buffer.alloc(0);
        let fullText = '';
        let trailerError = null;
        let settled = false;

        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { pollRes.destroy(); } catch (_) { /* ignore */ }
            resolve(result);
        };

        // Default timeout: keep CLI responsive; Cursor can stream longer, but we can re-poll.
        const timeoutMs = Number(process.env.CURSOR_POLL_TIMEOUT_MS || '15000');
        const timer = setTimeout(() => {
            finish({ ok: false, error: 'poll_timeout', fullText });
        }, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000);

        pollRes.on('data', (chunk) => {
            buf = Buffer.concat([buf, chunk]);
            const { frames, rest } = connectParseFrames(buf);
            buf = rest;

            for (const frame of frames) {
                const decoded = decodeConnectFrameData(frame);
                if (!decoded) continue;

                if (frame.flags & 0x02) {
                    // Trailer is JSON (sometimes gzipped).
                    const trailerStr = decoded.toString('utf8');
                    if (trailerStr.includes('\"error\"')) trailerError = trailerStr;
                    // Trailer typically means the stream is over; don't wait on socket close.
                    finish({ ok: false, error: trailerError || trailerStr, fullText });
                    return;
                }

                // BidiPollResponse protobuf
                const fields = pbDecode(decoded);
                for (const f of fields) {
                    if (f.f === 2 && f.w === 2) {
                        const dataStr = f.v.toString('utf8');
                        const text = parseCursorPollDataToText(dataStr);
                        if (text) {
                            fullText += text;
                            if (onTextDelta) onTextDelta(text);
                        }
                    }
                    if (f.f === 3 && f.w === 0 && f.v === 1) {
                        // eof=true
                        finish({ ok: true, fullText });
                        return;
                    }
                }
            }
        });

        pollRes.on('end', () => {
            if (trailerError) finish({ ok: false, error: trailerError, fullText });
            else finish({ ok: true, fullText });
        });

        pollRes.on('error', (err) => {
            finish({ ok: false, error: err.message || 'poll_stream_error', fullText });
        });
    });
}

// Stream Cursor response → OpenAI SSE chunks
function pipeToOpenAIStream(cursorRes, openAIRes, convId, model) {
    let buf = Buffer.alloc(0);
    let sentContent = false;

    const sendDelta = (text) => {
        if (!text) return;
        sentContent = true;
        openAIRes.write(`data: ${JSON.stringify({
            id: `chatcmpl-${convId}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
        })}\n\n`);
    };

    const finish = () => {
        openAIRes.write(`data: ${JSON.stringify({
            id: `chatcmpl-${convId}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
        })}\n\n`);
        openAIRes.write('data: [DONE]\n\n');
        openAIRes.end();
    };

    cursorRes.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const { frames, rest } = connectParseFrames(buf);
        buf = rest;
        for (const frame of frames) {
            const payload = decodeFramePayload(frame);
            if (!payload) continue;
            const text = extractText(payload);
            if (text) sendDelta(text);
        }
    });

    cursorRes.on('end', () => {
        if (!sentContent) sendDelta('[Cursor returned empty response – model may not be available]');
        finish();
    });

    cursorRes.on('error', (err) => {
        console.error('cursor stream error:', err.message);
        if (!sentContent) sendDelta(`[stream error: ${err.message}]`);
        finish();
    });
}

// Collect full Cursor response into a single string (for non-streaming)
function collectCursorResponse(cursorRes) {
    return new Promise((resolve) => {
        let buf = Buffer.alloc(0);
        let fullText = '';
        cursorRes.on('data', (chunk) => {
            buf = Buffer.concat([buf, chunk]);
            const { frames, rest } = connectParseFrames(buf);
            buf = rest;
            for (const frame of frames) {
                const payload = decodeFramePayload(frame);
                if (!payload) continue;
                fullText += extractText(payload);
            }
        });
        cursorRes.on('end', () => resolve(fullText));
        cursorRes.on('error', (err) => {
            console.error('cursor collect error:', err.message);
            resolve(fullText || `[stream error: ${err.message}]`);
        });
    });
}

// Handle OpenAI chat completions by translating to Cursor protocol
async function handleOpenAIChatCompletion(req, res, token, checksum, version) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
        try {
            const openAIRequest = JSON.parse(body);
            const messages = openAIRequest.messages || [];
            const model = openAIRequest.model || 'gpt-4';
            const wantsStream = openAIRequest.stream === true;

            console.log(`OpenAI→Cursor: model=${model}, msgs=${messages.length}, stream=${wantsStream}`);

            if (messages.length === 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'No messages provided' }));
                return;
            }

            const conversationId = crypto.randomUUID();

            if (wantsStream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream; charset=utf-8',
                    'Cache-Control': 'no-cache', 'Connection': 'keep-alive',
                    'Access-Control-Allow-Origin': '*'
                });

                let sentAnything = false;
                const sendDelta = (text) => {
                    if (!text) return;
                    sentAnything = true;
                    res.write(`data: ${JSON.stringify({
                        id: `chatcmpl-${conversationId}`,
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model,
                        choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
                    })}\n\n`);
                };

                const result = await cursorChatWithToolsPoll(messages, model, token, checksum, version, sendDelta);
                if (!result.ok) {
                    const msg = typeof result.error === 'string' ? result.error : 'cursor_error';
                    if (!sentAnything) sendDelta(`[Cursor error] ${msg}`);
                }

                res.write(`data: ${JSON.stringify({
                    id: `chatcmpl-${conversationId}`,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
                })}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
                return;
            }

            const result = await cursorChatWithToolsPoll(messages, model, token, checksum, version, null);
            const content = result.ok ? (result.fullText || '[empty response]') : (`[Cursor error] ${result.error}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(buildOpenAIChatCompletion(conversationId, model, content)));

        } catch (error) {
            console.error('Error processing OpenAI request:', error);
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
            }
            res.end(JSON.stringify({ error: 'Internal server error' }));
        }
    });
}

function handleOpenAIResponses(req, res, token, checksum, version) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
        let model = 'cursor-grok';
        let stream = false;
        let messages = [];
        try {
            const parsed = JSON.parse(body || '{}');
            if (parsed.model) model = parsed.model;
            stream = parsed.stream === true;
            // Convert /responses input to messages array for Cursor
            if (typeof parsed.input === 'string') {
                messages = [{ role: 'user', content: parsed.input }];
            } else if (Array.isArray(parsed.input)) {
                messages = parsed.input.map(m => ({
                    role: m.role || 'user',
                    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
                }));
            }
            if (parsed.instructions) {
                messages.unshift({ role: 'system', content: parsed.instructions });
            }
            console.log(`OpenAI /responses: model=${model}, stream=${stream}, msgs=${messages.length}`);
        } catch (_) {
            console.log('OpenAI /responses: malformed JSON body');
        }

        if (messages.length === 0) {
            console.log('OpenAI /responses: no messages, using fallback');
            if (stream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream; charset=utf-8',
                    'Cache-Control': 'no-cache', 'Connection': 'keep-alive'
                });
                res.write(`data: ${JSON.stringify({
                    type: 'response.output_text.delta',
                    delta: '[Cursor translation: no input provided]'
                })}\n\n`);
                res.write(`data: ${JSON.stringify({ type: 'response.completed' })}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                id: `resp_${crypto.randomUUID().replace(/-/g, '')}`,
                object: 'response',
                created_at: Math.floor(Date.now() / 1000),
                status: 'completed',
                model,
                output: [{
                    type: 'message',
                    id: `msg_${crypto.randomUUID().replace(/-/g, '')}`,
                    role: 'assistant',
                    content: [{ type: 'output_text', text: '[Cursor translation: no input provided]' }]
                }],
                output_text: '[Cursor translation: no input provided]'
            }));
            return;
        }

        // Use the new Poll+BidiAppend flow (same as /chat/completions)
        if (stream) {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache', 'Connection': 'keep-alive'
            });

            let sentAnything = false;
            const sendDelta = (text) => {
                if (!text) return;
                sentAnything = true;
                res.write(`data: ${JSON.stringify({
                    type: 'response.output_text.delta', delta: text
                })}\n\n`);
            };

            const result = await cursorChatWithToolsPoll(messages, model, token, checksum, version, sendDelta);
            if (!result.ok) {
                const msg = typeof result.error === 'string' ? result.error : 'cursor_error';
                if (!sentAnything) sendDelta(`[Cursor error] ${msg}`);
            }

            res.write(`data: ${JSON.stringify({ type: 'response.completed' })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
        }

        // Non-streaming
        const result = await cursorChatWithToolsPoll(messages, model, token, checksum, version, null);
        const fullText = result.ok ? (result.fullText || '[empty response]') : (`[Cursor error] ${result.error}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            id: `resp_${crypto.randomUUID().replace(/-/g, '')}`,
            object: 'response',
            created_at: Math.floor(Date.now() / 1000),
            status: 'completed',
            model,
            output: [{
                type: 'message',
                id: `msg_${crypto.randomUUID().replace(/-/g, '')}`,
                role: 'assistant',
                content: [{ type: 'output_text', text: fullText }]
            }],
            output_text: fullText
        }));
    });
}

function buildOpenAIChatCompletion(conversationId, model, content) {
    return {
        id: `chatcmpl-${conversationId}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
            index: 0,
            message: {
                role: 'assistant',
                content: content || '[empty response]'
            },
            finish_reason: 'stop'
        }]
    };
}

server.listen(PORT, '127.0.0.1', () => {
    const v = getCursorAppVersion();
    console.log(`Cursor proxy (Node.js) running on port ${PORT}`);
    console.log(`Proxying to ${TARGET_HOST} (emulating Cursor.app ${v})`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
    server.close(() => {
        console.log('Process terminated');
    });
});
