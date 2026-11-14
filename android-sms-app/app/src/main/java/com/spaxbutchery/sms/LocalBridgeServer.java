package com.spaxbutchery.sms;

import com.spaxbutchery.sms.CampaignModels.CampaignState;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Loopback-only HTTP bridge on 127.0.0.1:8765.
 * Never reachable over Wi-Fi or mobile data; requires an allowed browser Origin;
 * only stages campaigns into READY state so a human tap in Spax SMS is always
 * required before any chargeable SIM message is transmitted.
 */
public final class LocalBridgeServer {

    public static final int PORT = 8765;
    private static final int MAX_HEADER_BYTES = 8192;
    private static final int MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB

    public interface BatchListener {
        void onBatchStaged(CampaignState staged);
    }

    private final CampaignStore store;
    private final BatchListener batchListener;
    private volatile boolean running = false;
    private ServerSocket serverSocket;
    private Thread acceptThread;
    private ExecutorService clientPool;

    public LocalBridgeServer(CampaignStore store, BatchListener batchListener) {
        this.store = store;
        this.batchListener = batchListener;
    }

    public synchronized boolean start() {
        if (running) return true;
        try {
            ServerSocket ss = new ServerSocket();
            ss.setReuseAddress(true);
            ss.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), PORT), 16);
            this.serverSocket = ss;
            this.clientPool = Executors.newCachedThreadPool();
            this.running = true;
            this.store.setBridgeRunning(true);
            this.acceptThread = new Thread(this::acceptLoop, "SpaxLocalBridgeAccept");
            this.acceptThread.setDaemon(true);
            this.acceptThread.start();
            return true;
        } catch (IOException e) {
            this.running = false;
            this.store.setBridgeRunning(false);
            return false;
        }
    }

    public synchronized void stop() {
        running = false;
        store.setBridgeRunning(false);
        if (serverSocket != null) {
            try {
                serverSocket.close();
            } catch (IOException ignored) {
            }
            serverSocket = null;
        }
        if (clientPool != null) {
            clientPool.shutdownNow();
            clientPool = null;
        }
    }

    public boolean isRunning() {
        return running;
    }

    private void acceptLoop() {
        while (running) {
            try {
                ServerSocket ss = this.serverSocket;
                if (ss == null) break;
                Socket client = ss.accept();
                ExecutorService pool = this.clientPool;
                if (pool != null && !pool.isShutdown()) {
                    pool.execute(() -> handleClient(client));
                } else {
                    client.close();
                }
            } catch (IOException e) {
                if (!running) break;
            }
        }
    }

    private void handleClient(Socket socket) {
        try (Socket s = socket) {
            s.setSoTimeout(6000);
            InputStream rawIn = new BufferedInputStream(s.getInputStream());
            OutputStream out = s.getOutputStream();

            String headerBlock = readHeadersUtf8(rawIn);
            if (headerBlock == null || headerBlock.isEmpty()) return;

            String[] lines = headerBlock.split("\r\n");
            if (lines.length == 0) return;
            String[] reqParts = lines[0].split(" ");
            if (reqParts.length < 2) return;

            String method = reqParts[0].trim().toUpperCase(Locale.US);
            String rawTarget = reqParts[1].trim();
            String path = rawTarget;
            int qIdx = path.indexOf('?');
            if (qIdx >= 0) path = path.substring(0, qIdx);

            Map<String, String> headers = new HashMap<>();
            for (int i = 1; i < lines.length; i++) {
                int colon = lines[i].indexOf(':');
                if (colon > 0) {
                    String k = lines[i].substring(0, colon).trim().toLowerCase(Locale.US);
                    String v = lines[i].substring(colon + 1).trim();
                    headers.put(k, v);
                }
            }

            String origin = headers.get("origin");
            String allowedOrigin = resolveAllowedOrigin(origin);
            if (origin != null && allowedOrigin == null) {
                writeJson(out, 403, null, errorJson("Origin not allowed: " + origin));
                return;
            }

            if ("OPTIONS".equals(method)) {
                writePreflight(out, allowedOrigin != null ? allowedOrigin : "https://savluz-code.github.io");
                return;
            }

            if ("GET".equals(method) && "/ping".equals(path)) {
                JSONObject res = new JSONObject();
                try {
                    res.put("ok", true);
                    res.put("app", "spax-sms-companion");
                    res.put("version", "1.0.0");
                    res.put("port", PORT);
                } catch (JSONException ignored) {
                }
                writeJson(out, 200, allowedOrigin, res);
                return;
            }

            if ("GET".equals(method) && "/status".equals(path)) {
                writeJson(out, 200, allowedOrigin, store.publicStatusJson());
                return;
            }

            if ("POST".equals(method) && "/queue".equals(path)) {
                if (origin == null || allowedOrigin == null) {
                    writeJson(out, 403, null, errorJson("Browser Origin header required"));
                    return;
                }
                int contentLength = 0;
                try {
                    String cl = headers.get("content-length");
                    if (cl != null) contentLength = Integer.parseInt(cl);
                } catch (NumberFormatException e) {
                    writeJson(out, 400, allowedOrigin, errorJson("Invalid Content-Length"));
                    return;
                }
                if (contentLength <= 0 || contentLength > MAX_BODY_BYTES) {
                    writeJson(out, 413, allowedOrigin, errorJson("Batch body must be between 1 byte and 2 MB"));
                    return;
                }
                byte[] bodyBytes = readExactBytes(rawIn, contentLength);
                if (bodyBytes == null) {
                    writeJson(out, 400, allowedOrigin, errorJson("Incomplete request body"));
                    return;
                }
                String bodyUtf8 = new String(bodyBytes, StandardCharsets.UTF_8);
                try {
                    CampaignState staged = CampaignModels.parseIncomingBatch(bodyUtf8);
                    store.stageCampaign(staged, false);
                    if (batchListener != null) {
                        batchListener.onBatchStaged(staged);
                    }
                    JSONObject ok = new JSONObject();
                    ok.put("ok", true);
                    ok.put("campaignId", staged.campaignId);
                    ok.put("queued", staged.items.size());
                    ok.put("status", staged.status);
                    ok.put("skippedInvalid", staged.skippedInvalid);
                    ok.put("skippedDuplicate", staged.skippedDuplicate);
                    writeJson(out, 200, allowedOrigin, ok);
                } catch (IllegalStateException busy) {
                    writeJson(out, 409, allowedOrigin, errorJson(busy.getMessage()));
                } catch (JSONException badJson) {
                    writeJson(out, 400, allowedOrigin, errorJson(badJson.getMessage()));
                }
                return;
            }

            writeJson(out, 404, allowedOrigin, errorJson("Not found"));
        } catch (IOException ignored) {
        }
    }

    private String resolveAllowedOrigin(String origin) {
        if (origin == null || origin.isEmpty()) return null;
        try {
            URI uri = URI.create(origin);
            String scheme = uri.getScheme();
            String host = uri.getHost();
            if (scheme == null || host == null) return null;
            String normalizedHost = host.toLowerCase(Locale.US);
            String reconstructed = scheme.toLowerCase(Locale.US) + "://" + normalizedHost
                    + (uri.getPort() != -1 ? ":" + uri.getPort() : "");
            if (!reconstructed.equalsIgnoreCase(origin)) return null;

            if ("https".equalsIgnoreCase(scheme) && "savluz-code.github.io".equals(normalizedHost)) {
                return origin;
            }
            if (("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme))
                    && ("localhost".equals(normalizedHost) || "127.0.0.1".equals(normalizedHost))) {
                return origin;
            }
            if ("https".equalsIgnoreCase(scheme) && normalizedHost.endsWith(".e2b.app")) {
                return origin;
            }
            String custom = store.getCustomOrigin();
            if (!custom.isEmpty() && custom.equalsIgnoreCase(origin)) {
                return origin;
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    private static String readHeadersUtf8(InputStream in) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream(512);
        int state = 0; // matches \r\n\r\n
        while (bos.size() < MAX_HEADER_BYTES) {
            int b = in.read();
            if (b == -1) break;
            bos.write(b);
            if ((state == 0 || state == 2) && b == '\r') state++;
            else if ((state == 1 || state == 3) && b == '\n') state++;
            else state = (b == '\r') ? 1 : 0;
            if (state == 4) {
                byte[] bytes = bos.toByteArray();
                return new String(bytes, 0, bytes.length - 4, StandardCharsets.UTF_8);
            }
        }
        return null;
    }

    private static byte[] readExactBytes(InputStream in, int length) throws IOException {
        byte[] buf = new byte[length];
        int offset = 0;
        while (offset < length) {
            int n = in.read(buf, offset, length - offset);
            if (n == -1) return null;
            offset += n;
        }
        return buf;
    }

    private static JSONObject errorJson(String msg) {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", false);
            o.put("error", msg == null ? "Error" : msg);
        } catch (JSONException ignored) {
        }
        return o;
    }

    private static void writePreflight(OutputStream out, String origin) throws IOException {
        String headers = "HTTP/1.1 204 No Content\r\n"
                + "Access-Control-Allow-Origin: " + origin + "\r\n"
                + "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
                + "Access-Control-Allow-Headers: Content-Type, Authorization, X-Spax-Client\r\n"
                + "Access-Control-Allow-Private-Network: true\r\n"
                + "Access-Control-Max-Age: 600\r\n"
                + "Vary: Origin\r\n"
                + "Content-Length: 0\r\n"
                + "Connection: close\r\n\r\n";
        out.write(headers.getBytes(StandardCharsets.UTF_8));
        out.flush();
    }

    private static void writeJson(OutputStream out, int status, String origin, JSONObject json) throws IOException {
        byte[] body = (json != null ? json.toString() : "{}").getBytes(StandardCharsets.UTF_8);
        String statusText = statusReason(status);
        StringBuilder sb = new StringBuilder(256);
        sb.append("HTTP/1.1 ").append(status).append(' ').append(statusText).append("\r\n");
        sb.append("Content-Type: application/json; charset=utf-8\r\n");
        sb.append("Cache-Control: no-store\r\n");
        if (origin != null) {
            sb.append("Access-Control-Allow-Origin: ").append(origin).append("\r\n");
            sb.append("Access-Control-Allow-Private-Network: true\r\n");
            sb.append("Vary: Origin\r\n");
        }
        sb.append("Content-Length: ").append(body.length).append("\r\n");
        sb.append("Connection: close\r\n\r\n");
        out.write(sb.toString().getBytes(StandardCharsets.UTF_8));
        out.write(body);
        out.flush();
    }

    private static String statusReason(int code) {
        switch (code) {
            case 200: return "OK";
            case 204: return "No Content";
            case 400: return "Bad Request";
            case 403: return "Forbidden";
            case 404: return "Not Found";
            case 409: return "Conflict";
            case 413: return "Payload Too Large";
            default: return "Error";
        }
    }
}
