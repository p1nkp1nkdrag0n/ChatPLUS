package app.dearvale.mobile;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.util.Base64;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.HttpAuthHandler;
import android.webkit.SslErrorHandler;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    protected boolean onlineMode() { return false; }
    private static final int PAPER = Color.rgb(250, 248, 243);
    private static final int INK = Color.rgb(46, 55, 43);
    private static final int SAGE = Color.rgb(111, 128, 101);
    private static final int MUTED = Color.rgb(116, 121, 109);
    private static final int UPLOAD_REQUEST = 71;
    private static final int SAVE_REQUEST = 72;
    private static final int MAX_EXPORT_BYTES = 20 * 1024 * 1024;
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Set<String> bundledAssets = new HashSet<>();
    private FrameLayout root;
    private WebView webView;
    private LinearLayout connectionForm;
    private ScrollView connectionScroll;
    private EditText addressInput, userInput, passwordInput;
    private CheckBox allowHttp;
    private TextView statusText;
    private Button connectButton;
    private SharedPreferences preferences;
    private volatile String serverOrigin = "";
    private volatile String sessionUser = "";
    private volatile String sessionPassword = "";
    private int connectGeneration = 0;
    private ValueCallback<Uri[]> fileCallback;
    private byte[] pendingExport;

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        if (Build.VERSION.SDK_INT >= 33) getOnBackInvokedDispatcher().registerOnBackInvokedCallback(0, this::onBackPressed);
        preferences = getSharedPreferences(onlineMode() ? "online-connection" : "connection", MODE_PRIVATE);
        root = new FrameLayout(this);
        root.setBackgroundColor(PAPER);
        // Android 15 enforces edge-to-edge; use the real system/IME insets once.
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                android.graphics.Insets ime = insets.getInsets(WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
            }
            return insets;
        });
        setContentView(root);
        root.requestApplyInsets();
        if (!onlineMode()) { try { collectAssets("web", ""); } catch (Exception ignored) { } }
        createWebView();
        showConnection("");
    }

    private void collectAssets(String folder, String prefix) throws Exception {
        String[] children = getAssets().list(folder);
        if (children == null) return;
        for (String child : children) {
            String local = prefix + child;
            String[] nested = getAssets().list(folder + "/" + child);
            if (nested != null && nested.length > 0) collectAssets(folder + "/" + child, local + "/");
            else bundledAssets.add(local);
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void createWebView() {
        webView = new WebView(this);
        webView.setBackgroundColor(PAPER);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setUserAgentString(settings.getUserAgentString() + " DearvaleAndroid/1.0");
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        webView.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                String target = request.getUrl().toString();
                if (!ServerAddress.sameOrigin(serverOrigin, target)) return emptyResponse(403, "Forbidden");
                if (onlineMode()) return null;
                if (!request.getMethod().equals("GET")) return null;
                String path = request.getUrl().getPath();
                if (path == null || path.startsWith("/api/") || path.equals("/api")) return null;
                String asset = path.startsWith("/") ? path.substring(1) : path;
                if (asset.contains("..") || asset.contains("\\")) return emptyResponse(400, "Bad Request");
                if (!bundledAssets.contains(asset)) {
                    if (request.isForMainFrame() && !asset.substring(asset.lastIndexOf('/') + 1).contains(".")) asset = "index.html";
                    else return emptyResponse(404, "Not Found");
                }
                try {
                    String mime = mimeFor(asset);
                    Map<String, String> headers = new HashMap<>();
                    headers.put("Cache-Control", "no-cache");
                    headers.put("X-Content-Type-Options", "nosniff");
                    return new WebResourceResponse(mime, "UTF-8", 200, "OK", headers, getAssets().open("web/" + asset));
                } catch (Exception error) { return emptyResponse(404, "Not Found"); }
            }

            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (url.equals("dearvale://connection") || url.equals("dearvale-online://connection")) {
                    showConnection("");
                    return true;
                }
                if (ServerAddress.sameOrigin(serverOrigin, url)) return false;
                if (request.isForMainFrame()) openExternal(request.getUrl());
                return true;
            }

            @Override public void onReceivedHttpAuthRequest(WebView view, HttpAuthHandler auth, String host, String realm) {
                if (host.equalsIgnoreCase(Uri.parse(serverOrigin).getHost()) && !sessionUser.isEmpty() && auth.useHttpAuthUsernamePassword()) {
                    auth.proceed(sessionUser, sessionPassword);
                } else {
                    auth.cancel();
                    showConnection("服务需要认证，或当前账号密码已经失效。请重新连接。");
                }
            }

            @Override public void onReceivedSslError(WebView view, SslErrorHandler ssl, SslError error) {
                ssl.cancel();
                showConnection("HTTPS 证书校验失败。请检查服务域名与证书，再重试连接。");
            }

            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showConnection("暂时无法打开服务，请检查网络后重新连接。");
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try { startActivityForResult(params.createIntent(), UPLOAD_REQUEST); }
                catch (ActivityNotFoundException error) {
                    fileCallback.onReceiveValue(null);
                    fileCallback = null;
                    toast("这台手机没有可用的文件选择器。");
                }
                return true;
            }
        });
        webView.setDownloadListener((url, agent, disposition, mime, size) -> download(url, disposition, mime));
        root.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        webView.setVisibility(View.GONE);
    }

    private void showConnection(String message) {
        connectGeneration++;
        webView.setVisibility(View.GONE);
        if (connectionScroll != null) root.removeView(connectionScroll);
        connectionScroll = new ScrollView(this);
        connectionScroll.setFillViewport(true);
        connectionForm = new LinearLayout(this);
        connectionForm.setOrientation(LinearLayout.VERTICAL);
        connectionForm.setPadding(dp(28), dp(38), dp(28), dp(28));
        connectionScroll.addView(connectionForm, new ScrollView.LayoutParams(-1, -2));
        TextView brand = text(onlineMode() ? "D E A R V A L E  ·  ONLINE" : "D E A R V A L E", 13, SAGE, true);
        add(brand, 0, 28);
        TextView title = text("让陪伴，\n随你出发。", 34, INK, true);
        title.setLineSpacing(dp(5), 1);
        add(title, 0, 14);
        add(text(onlineMode() ? "连接朋友提供的 Dearvale 服务，\n用邀请码注册，回到属于你的故事。" : "连接你的电脑或私人服务器，\n把熟悉的对话装进口袋。", 16, MUTED, false), 0, 32);
        add(text("服务地址", 14, INK, true), 0, 9);
        addressInput = input("https://dearvale.example.com", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        addressInput.setText(preferences.getString("origin", ""));
        add(addressInput, 0, 18);
        if (!onlineMode()) add(text("访问账号 · 按服务提供的账号填写", 13, MUTED, false), 0, 9);
        userInput = input("账号（无需认证时留空）", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD);
        userInput.setText(preferences.getString("username", ""));
        if (!onlineMode()) add(userInput, 0, 10);
        passwordInput = input("访问密码", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        passwordInput.setText(sessionPassword);
        if (!onlineMode()) add(passwordInput, 0, 14);
        allowHttp = new CheckBox(this);
        allowHttp.setText(R.string.http_consent);
        allowHttp.setTextSize(12);
        allowHttp.setTextColor(MUTED);
        allowHttp.setMinHeight(dp(44));
        allowHttp.setChecked(preferences.getBoolean("allowHttp", false));
        if (!onlineMode()) add(allowHttp, 0, 16);
        statusText = text(message, 13, Color.rgb(149, 73, 64), false);
        statusText.setVisibility(message.isEmpty() ? View.GONE : View.VISIBLE);
        add(statusText, 0, 12);
        connectButton = button("连接 Dearvale", SAGE, Color.WHITE);
        connectButton.setOnClickListener(view -> connect());
        add(connectButton, 0, 14);
        if (!serverOrigin.isEmpty()) {
            Button resume = button("返回当前对话", Color.TRANSPARENT, SAGE);
            resume.setOnClickListener(view -> revealWebView());
            add(resume, 0, 8);
        }
        add(text(onlineMode() ? "账号、对话和积分保存在服务器中。\n连接后即可登录或使用邀请码注册。" : "对话和模型设置保存在你连接的服务中。\n访问密码仅保留在本次应用会话内。", 12, MUTED, false), 9, 24);
        TextView help = text("查看连接方式  ↗", 13, SAGE, true);
        help.setMinHeight(dp(44));
        help.setGravity(Gravity.CENTER_VERTICAL);
        help.setOnClickListener(view -> new AlertDialog.Builder(this).setTitle("连接你的 Dearvale")
                .setMessage(onlineMode() ? "填写朋友提供的完整 HTTPS 服务根地址，例如 https://dearvale.example.com。\n\n连接后在服务页面登录，或使用用户名、密码和邀请码注册。\n\n这里填写的是 Dearvale 服务地址，不是模型供应商的 API 地址。" : "电脑无线连接：在电脑运行 pnpm mobile:serve，将终端显示的地址、账号和密码填入这里。手机与电脑需在同一可信 Wi-Fi。HTTP 传输没有加密。\n\n私人服务器：填写已经启用 HTTPS 与访问认证的服务根地址。\n\nUSB 调试：在电脑执行 adb reverse tcp:3001 tcp:3001，再填写 http://127.0.0.1:3001。\n\n这里填写的是 Dearvale 服务地址，不是模型供应商的 API 地址。")
                .setPositiveButton("知道了", null).show());
        add(help, 0, 0);
        root.addView(connectionScroll, new FrameLayout.LayoutParams(-1, -1));
    }

    private void connect() {
        final String origin;
        try { origin = onlineMode() ? ServerAddress.normalizeOnline(addressInput.getText().toString()) : ServerAddress.normalize(addressInput.getText().toString(), allowHttp.isChecked()); }
        catch (IllegalArgumentException error) { showStatus(error.getMessage()); return; }
        final String username = onlineMode() ? "" : userInput.getText().toString().trim();
        final String password = onlineMode() ? "" : passwordInput.getText().toString();
        final int generation = ++connectGeneration;
        final boolean permitHttp = allowHttp.isChecked();
        connectButton.setEnabled(false);
        connectButton.setText("正在连接…");
        showStatus("");
        network.execute(() -> {
            String failure = null;
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(origin + "/api/health").openConnection();
                connection.setConnectTimeout(10000);
                connection.setReadTimeout(10000);
                connection.setInstanceFollowRedirects(false);
                connection.setRequestProperty("Accept", "application/json");
                if (!username.isEmpty()) connection.setRequestProperty("Authorization", basic(username, password));
                int code = connection.getResponseCode();
                if (code == 401 || code == 403) failure = "账号或密码不正确，请使用 Dearvale 服务的访问凭据。";
                else if (code >= 300 && code < 400) failure = "服务发生跳转，请直接填写跳转后的 HTTPS 根地址。";
                else if (code != 200) failure = "服务返回 HTTP " + code + "，请确认地址对应正在运行的 Dearvale。";
                else {
                    byte[] content = readLimited(connection.getInputStream(), 128 * 1024);
                    JSONObject health = new JSONObject(new String(content, StandardCharsets.UTF_8));
                    if (!health.optBoolean("ok") && !"ok".equals(health.optString("status"))) failure = "这个地址没有返回 Dearvale 的健康状态。";
                }
            } catch (javax.net.ssl.SSLException error) { failure = "HTTPS 证书校验失败，请修复服务证书后重试。"; }
            catch (Exception error) { failure = "连接未成功。请确认服务已启动、地址端口正确，且手机可以访问它。"; }
            finally { if (connection != null) connection.disconnect(); }
            final String result = failure;
            runOnUiThread(() -> {
                if (isDestroyed() || generation != connectGeneration) return;
                connectButton.setEnabled(true);
                connectButton.setText(R.string.connect);
                if (result != null) { showStatus(result); return; }
                boolean changed = !origin.equals(serverOrigin) || !username.equals(sessionUser) || !password.equals(sessionPassword);
                serverOrigin = origin;
                sessionUser = username;
                sessionPassword = password;
                preferences.edit().putString("origin", origin).putString("username", username).putBoolean("allowHttp", permitHttp).apply();
                ((InputMethodManager) getSystemService(INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(addressInput.getWindowToken(), 0);
                // A fresh WebView prevents a prior instance's HTTP-auth cache from surviving a switch.
                if (changed) {
                    root.removeView(webView);
                    webView.destroy();
                    createWebView();
                }
                revealWebView();
                webView.loadUrl(origin + (onlineMode() ? "/" : "/welcome"));
            });
        });
    }

    private void revealWebView() {
        if (connectionScroll != null) connectionScroll.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
    }

    private void download(String url, String disposition, String mime) {
        if (url.startsWith("blob:") && ServerAddress.sameOrigin(serverOrigin, url.substring(5))) {
            String script = "window.__dearvaleExport=null;fetch(" + JSONObject.quote(url) + ").then(r=>r.blob()).then(b=>{if(b.size>" + MAX_EXPORT_BYTES + ")throw Error('large');const f=new FileReader();f.onload=()=>window.__dearvaleExport=f.result;f.onerror=()=>window.__dearvaleExport='error';f.readAsDataURL(b)}).catch(()=>window.__dearvaleExport='error');";
            webView.evaluateJavascript(script, null);
            pollExport(0, mime);
        } else if (url.startsWith("data:")) saveDataUrl(url, mime);
        else if (ServerAddress.sameOrigin(serverOrigin, url)) {
            final String origin = serverOrigin, username = sessionUser, password = sessionPassword;
            final String cookies = CookieManager.getInstance().getCookie(url);
            network.execute(() -> {
                HttpURLConnection connection = null;
                try {
                    connection = (HttpURLConnection) new URL(url).openConnection();
                    connection.setConnectTimeout(10000);
                    connection.setReadTimeout(30000);
                    connection.setInstanceFollowRedirects(false);
                    if (!ServerAddress.sameOrigin(origin, url)) return;
                    if (!username.isEmpty()) connection.setRequestProperty("Authorization", basic(username, password));
                    if (cookies != null) connection.setRequestProperty("Cookie", cookies);
                    if (connection.getResponseCode() != 200) throw new IllegalStateException("download");
                    byte[] bytes = readLimited(connection.getInputStream(), MAX_EXPORT_BYTES);
                    runOnUiThread(() -> beginSave(bytes, mime, URLUtil.guessFileName(url, disposition, mime)));
                } catch (Exception error) { runOnUiThread(() -> toast("下载失败，文件需小于 20 MB，请重试。")); }
                finally { if (connection != null) connection.disconnect(); }
            });
        } else openExternal(Uri.parse(url));
    }

    private void pollExport(int attempt, String mime) {
        if (attempt > 100 || isDestroyed()) { toast("导出超时，请重试。"); return; }
        handler.postDelayed(() -> webView.evaluateJavascript("window.__dearvaleExport", raw -> {
            try {
                Object result = new JSONTokener(raw).nextValue();
                if (result instanceof String && ((String) result).startsWith("data:")) {
                    webView.evaluateJavascript("delete window.__dearvaleExport", null);
                    saveDataUrl((String) result, mime);
                } else if ("error".equals(result)) toast("无法导出这个文件，文件需小于 20 MB。");
                else pollExport(attempt + 1, mime);
            } catch (Exception error) { toast("导出失败，请重试。"); }
        }), 150);
    }

    private void saveDataUrl(String url, String defaultMime) {
        try {
            int comma = url.indexOf(',');
            if (comma < 0 || !url.substring(0, comma).endsWith(";base64") || url.length() > MAX_EXPORT_BYTES * 1.4) throw new IllegalArgumentException();
            String mime = url.substring(5, url.indexOf(';'));
            byte[] bytes = Base64.decode(url.substring(comma + 1), Base64.DEFAULT);
            beginSave(bytes, mime.isEmpty() ? defaultMime : mime, "Dearvale-" + System.currentTimeMillis() + (mime.equals("image/png") ? ".png" : ".bin"));
        } catch (Exception error) { toast("无法保存这个文件。"); }
    }

    private void beginSave(byte[] bytes, String mime, String name) {
        if (isDestroyed()) return;
        pendingExport = bytes;
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime)
                .putExtra(Intent.EXTRA_TITLE, name);
        try { startActivityForResult(intent, SAVE_REQUEST); }
        catch (ActivityNotFoundException error) { pendingExport = null; toast("这台手机没有可用的文件保存器。"); }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == UPLOAD_REQUEST && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
        } else if (requestCode == SAVE_REQUEST) {
            byte[] bytes = pendingExport;
            pendingExport = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null && bytes != null) {
                Uri target = data.getData();
                network.execute(() -> {
                    try (OutputStream output = getContentResolver().openOutputStream(target)) {
                        if (output == null) throw new IllegalStateException("no output");
                        output.write(bytes);
                        runOnUiThread(() -> toast("已保存到你选择的位置。"));
                    } catch (Exception error) { runOnUiThread(() -> toast("保存失败，请重新导出。")); }
                });
            }
        }
    }

    @Override public void onBackPressed() {
        if (Build.VERSION.SDK_INT >= 30 && root.getRootWindowInsets() != null
                && root.getRootWindowInsets().isVisible(WindowInsets.Type.ime())) {
            ((InputMethodManager) getSystemService(INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(root.getWindowToken(), 0);
            return;
        }
        if (webView.getVisibility() == View.VISIBLE) {
            webView.evaluateJavascript("(()=>{const dialog=document.querySelector('dialog[open]');if(dialog){dialog.close();return true;}const details=document.querySelector('details[open]');if(details){details.open=false;return true;}return false;})()", handled -> {
                if (!"true".equals(handled)) navigateBack();
            });
        } else if (!serverOrigin.isEmpty()) revealWebView();
        else showAppMenu();
    }

    private void navigateBack() {
        if (webView.canGoBack()) webView.goBack();
        else showAppMenu();
    }

    private void showAppMenu() {
        new AlertDialog.Builder(this).setTitle(onlineMode() ? "Dearvale Online" : "Dearvale")
                .setItems(new String[] { "连接设置", "退出应用" }, (dialog, which) -> { if (which == 0) showConnection(""); else finish(); }).show();
    }

    @Override protected void onDestroy() {
        connectGeneration++;
        handler.removeCallbacksAndMessages(null);
        network.shutdownNow();
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        if (webView != null) webView.destroy();
        pendingExport = null;
        sessionPassword = "";
        super.onDestroy();
    }

    private void openExternal(Uri uri) {
        String scheme = uri.getScheme();
        if (!"https".equalsIgnoreCase(scheme) && !"http".equalsIgnoreCase(scheme) && !"mailto".equalsIgnoreCase(scheme)) { toast("暂不支持打开这个链接。"); return; }
        try { startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)); }
        catch (ActivityNotFoundException error) { toast("没有可打开此链接的应用。"); }
    }

    private static String basic(String username, String password) {
        return "Basic " + Base64.encodeToString((username + ":" + password).getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
    }

    private static byte[] readLimited(InputStream source, int limit) throws Exception {
        try (InputStream input = source; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) {
                if (output.size() + count > limit) throw new IllegalArgumentException("too large");
                output.write(buffer, 0, count);
            }
            return output.toByteArray();
        }
    }

    private WebResourceResponse emptyResponse(int status, String reason) {
        return new WebResourceResponse("text/plain", "UTF-8", status, reason, new HashMap<>(), new ByteArrayInputStream(new byte[0]));
    }

    private static String mimeFor(String file) {
        if (file.endsWith(".html")) return "text/html";
        if (file.endsWith(".js")) return "application/javascript";
        if (file.endsWith(".css")) return "text/css";
        if (file.endsWith(".svg")) return "image/svg+xml";
        if (file.endsWith(".png")) return "image/png";
        if (file.endsWith(".jpg") || file.endsWith(".jpeg")) return "image/jpeg";
        if (file.endsWith(".webp")) return "image/webp";
        if (file.endsWith(".avif")) return "image/avif";
        if (file.endsWith(".woff2")) return "font/woff2";
        if (file.endsWith(".json")) return "application/json";
        return "application/octet-stream";
    }

    private void showStatus(String message) { statusText.setText(message); statusText.setVisibility(message.isEmpty() ? View.GONE : View.VISIBLE); }
    private void toast(String message) { Toast.makeText(this, message, Toast.LENGTH_LONG).show(); }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private GradientDrawable background(int color, int radius) { GradientDrawable bg = new GradientDrawable(); bg.setColor(color); bg.setCornerRadius(dp(radius)); return bg; }
    private TextView text(String value, int size, int color, boolean bold) {
        TextView view = new TextView(this); view.setText(value); view.setTextSize(size); view.setTextColor(color);
        view.setLineSpacing(dp(4), 1); if (bold) view.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); return view;
    }
    private EditText input(String hint, int type) {
        EditText view = new EditText(this); view.setHint(hint); view.setInputType(type); view.setSingleLine(true);
        view.setTextSize(15); view.setTextColor(INK); view.setHintTextColor(MUTED); view.setPadding(dp(17), dp(14), dp(17), dp(14));
        view.setMinHeight(dp(54)); view.setBackground(background(Color.WHITE, 16)); view.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO); return view;
    }
    private Button button(String label, int color, int foreground) {
        Button view = new Button(this); view.setText(label); view.setAllCaps(false); view.setTextSize(16); view.setTextColor(foreground);
        view.setMinHeight(dp(54)); view.setElevation(0); view.setBackground(background(color, 18)); return view;
    }
    private void add(View child, int top, int bottom) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.setMargins(0, dp(top), 0, dp(bottom)); connectionForm.addView(child, params);
    }
}
