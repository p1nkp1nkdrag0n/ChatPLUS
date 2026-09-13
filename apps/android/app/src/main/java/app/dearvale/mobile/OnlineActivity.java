package app.dearvale.mobile;

/** Independent application ID/data store; loads the hosted application over HTTPS. */
public final class OnlineActivity extends MainActivity {
    @Override protected boolean onlineMode() { return true; }
}
