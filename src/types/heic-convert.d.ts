declare module "heic-convert" {
  interface ConvertOptions {
    buffer: Buffer | Uint8Array | ArrayBuffer;
    format: "JPEG" | "PNG";
    /** JPEG quality between 0 and 1. */
    quality?: number;
  }
  function convert(options: ConvertOptions): Promise<ArrayBuffer | Buffer>;
  export default convert;
}
