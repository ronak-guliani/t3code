const { withEntitlementsPlist } = require("expo/config-plugins");

module.exports = function withLocalOnlyNotifications(config) {
  return withEntitlementsPlist(config, (nextConfig) => {
    // expo-notifications adds APNs by default even when only local notifications are used.
    delete nextConfig.modResults["aps-environment"];
    return nextConfig;
  });
};
