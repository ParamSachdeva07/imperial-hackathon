import type { DesktopApi } from '../../../packages/contracts/src/index';
declare global {
  interface Window {
    desktop: DesktopApi;
  }
}
