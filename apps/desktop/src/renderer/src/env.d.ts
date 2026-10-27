import type { KovanApi } from '../../shared/api';

declare global {
  interface Window {
    kovan: KovanApi;
  }
}
