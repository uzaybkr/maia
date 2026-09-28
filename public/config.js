// Build-time settings for the iOS/Android apps. The web app ignores apiBase and talks to its own origin.
window.MAIA_CONFIG = {
  // Public HTTPS URL of the deployed Maia server, e.g. 'https://api.yourdomain.com'. Required before store builds.
  apiBase: '',
  // RevenueCat public SDK keys (appl_... / goog_...). Safe to ship in the app; leave empty until the project exists.
  revenuecat: { ios: '', android: '' },
};
