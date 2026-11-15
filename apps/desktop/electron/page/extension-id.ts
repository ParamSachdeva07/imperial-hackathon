/**
 * The id Chrome derives from the public key in extension/page-bridge/manifest.json. The bridge
 * server accepts requests only from this extension's origin, which a web page cannot forge.
 */
export const PAGE_BRIDGE_EXTENSION_ID = 'fnkgdiiboieohdmillkacfkpfgidnfmf';
export const PAGE_BRIDGE_PORT = 8767;
/** The extension version this app speaks to. An older copy still loaded in the browser is not used. */
export const PAGE_BRIDGE_VERSION = '0.2.2';
