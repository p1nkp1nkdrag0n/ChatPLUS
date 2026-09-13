package app.dearvale.mobile;

import org.junit.Test;
import static org.junit.Assert.*;

public class ServerAddressTest {
    @Test public void onlineBuildRequiresHttpsEvenForLoopback() {
        assertEquals("https://example.com", ServerAddress.normalizeOnline("https://example.com/"));
        assertThrows(IllegalArgumentException.class, () -> ServerAddress.normalizeOnline("http://127.0.0.1:3001"));
        assertThrows(IllegalArgumentException.class, () -> ServerAddress.normalizeOnline("http://192.168.1.8:3000"));
    }
    @Test public void permitsHttpsAndUsbLoopback() {
        assertEquals("https://dearvale.example", ServerAddress.normalize(" https://Dearvale.example/ ", false));
        assertEquals("http://127.0.0.1:3001", ServerAddress.normalize("http://127.0.0.1:3001", false));
    }
    @Test public void requiresExplicitConsentForCleartextLan() {
        assertThrows(IllegalArgumentException.class, () -> ServerAddress.normalize("http://192.168.1.8:3000", false));
        assertEquals("http://192.168.1.8:3000", ServerAddress.normalize("http://192.168.1.8:3000", true));
    }
    @Test public void rejectsCredentialsPathsAndUntrustedSchemes() {
        for (String url : new String[] { "https://user:secret@example.com", "https://example.com/api", "https://example.com?x=1", "javascript:alert(1)", "file:///sdcard/x", "https://example.com:99999" }) {
            assertThrows(url, IllegalArgumentException.class, () -> ServerAddress.normalize(url, true));
        }
    }
    @Test public void comparesCompleteOriginsNotPrefixes() {
        assertTrue(ServerAddress.sameOrigin("https://example.com", "https://example.com:443/api"));
        assertFalse(ServerAddress.sameOrigin("https://example.com", "https://example.com.evil.test/api"));
        assertFalse(ServerAddress.sameOrigin("https://example.com", "http://example.com/api"));
        assertFalse(ServerAddress.sameOrigin("https://example.com", "https://example.com:444/api"));
    }
}
