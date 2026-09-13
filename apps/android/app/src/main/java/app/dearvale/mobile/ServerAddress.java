package app.dearvale.mobile;

import java.net.URI;
import java.util.Locale;

/** Pure address policy, shared by connection checks and WebView navigation. */
final class ServerAddress {
    private ServerAddress() {}

    static String normalizeOnline(String value) {
        String origin = normalize(value, false);
        if (!origin.startsWith("https://")) throw new IllegalArgumentException("联网测试版仅支持 HTTPS 服务地址。");
        return origin;
    }

    static String normalize(String value, boolean allowHttp) {
        try {
            URI uri = new URI(value.trim());
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            if (!scheme.equals("https") && !scheme.equals("http")) {
                throw new IllegalArgumentException("请填写完整的 https:// 或 http:// 服务地址。");
            }
            if (uri.getHost() == null || uri.getUserInfo() != null || uri.getQuery() != null
                    || uri.getFragment() != null || (uri.getPath() != null && !uri.getPath().isEmpty() && !uri.getPath().equals("/"))) {
                throw new IllegalArgumentException("请只填写服务地址和端口，不包含路径、账号、查询参数或 #。");
            }
            if (uri.getPort() == 0 || uri.getPort() > 65535) throw new IllegalArgumentException("服务端口无效。");
            if (scheme.equals("http") && !allowHttp && !isLoopback(uri.getHost())) {
                throw new IllegalArgumentException("HTTP 连接没有加密。请确认仅在可信局域网内使用。");
            }
            return scheme + "://" + uri.getRawAuthority().toLowerCase(Locale.ROOT);
        } catch (java.net.URISyntaxException error) {
            throw new IllegalArgumentException("服务地址格式不正确。", error);
        }
    }

    static boolean sameOrigin(String origin, String candidate) {
        try {
            URI a = new URI(origin), b = new URI(candidate);
            return a.getScheme().equalsIgnoreCase(b.getScheme()) && a.getHost().equalsIgnoreCase(b.getHost())
                    && effectivePort(a) == effectivePort(b) && b.getUserInfo() == null;
        } catch (Exception error) { return false; }
    }

    private static int effectivePort(URI uri) {
        return uri.getPort() >= 0 ? uri.getPort() : ("https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80);
    }

    static boolean isLoopback(String host) {
        String normalized = host.toLowerCase(Locale.ROOT);
        return normalized.equals("localhost") || normalized.equals("127.0.0.1")
                || normalized.equals("[::1]") || normalized.equals("::1");
    }
}
