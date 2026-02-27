declare module 'zstd-codec' {
  export class ZSTDDecoder {
    init(): Promise<void>;
    decode(compressedData: Uint8Array, originalSize: number): Uint8Array;
  }
}
