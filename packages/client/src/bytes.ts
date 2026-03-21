import type { SerializedBytes } from "@local-firestore/shared";

/**
 * バイナリデータを表す不変オブジェクト。
 * Firebase Firestore の Bytes 互換。
 */
export class Bytes {
  private constructor(private readonly _bytes: Uint8Array) {}

  /** Uint8Array から Bytes を作成する */
  static fromUint8Array(array: Uint8Array): Bytes {
    return new Bytes(new Uint8Array(array));
  }

  /** Base64 文字列から Bytes を作成する */
  static fromBase64String(base64: string): Bytes {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Bytes(bytes);
  }

  /** Uint8Array として返す */
  toUint8Array(): Uint8Array {
    return new Uint8Array(this._bytes);
  }

  /** Base64 文字列として返す */
  toBase64(): string {
    let binary = "";
    for (const byte of this._bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary);
  }

  isEqual(other: Bytes): boolean {
    if (this._bytes.length !== other._bytes.length) return false;
    for (let i = 0; i < this._bytes.length; i++) {
      if (this._bytes[i] !== other._bytes[i]) return false;
    }
    return true;
  }

  /** @internal シリアライズ形式に変換 */
  toSerialized(): SerializedBytes {
    return {
      __type: "bytes",
      value: this.toBase64(),
    };
  }

  /** @internal シリアライズ形式から復元 */
  static fromSerialized(value: string): Bytes {
    return Bytes.fromBase64String(value);
  }
}
