import type { OverlayBridge } from '../shared/bridge';
declare global { interface Window { overlay: OverlayBridge; } }
