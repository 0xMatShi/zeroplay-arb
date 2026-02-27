// Global type declarations to suppress ox library errors
// @ts-nocheck

declare module 'ox/core/Errors' {
  export class BaseError extends Error {
    constructor(message?: string, options?: { cause?: unknown });
    override cause: unknown;
  }
}

declare module 'ox/core/internal/abiParameters' {
  export function encodeArray(value: any, options: any): any;
}

declare module 'ox/core/Secp256k1' {
  export function recoverAddress(options: any): string;
}

declare module 'ox/core/Signature' {
  export function fromLegacy(signature: any): any;
}

declare module 'ox/tempo/SignatureEnvelope' {
  export interface SignatureEnvelope {
    prehash?: boolean;
  }
}
