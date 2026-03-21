import type { SerializedGeoPoint } from "@local-firestore/shared";
import { FirestoreError } from "./transport.js";

/**
 * 地理座標を表す不変オブジェクト。
 * Firebase Firestore の GeoPoint 互換。
 */
export class GeoPoint {
  constructor(
    readonly latitude: number,
    readonly longitude: number,
  ) {
    if (latitude < -90 || latitude > 90) {
      throw new FirestoreError(
        "invalid-argument",
        `Latitude must be in the range of [-90, 90], but was ${latitude}`,
      );
    }
    if (longitude < -180 || longitude > 180) {
      throw new FirestoreError(
        "invalid-argument",
        `Longitude must be in the range of [-180, 180], but was ${longitude}`,
      );
    }
  }

  isEqual(other: GeoPoint): boolean {
    return this.latitude === other.latitude && this.longitude === other.longitude;
  }

  /** @internal シリアライズ形式に変換 */
  toSerialized(): SerializedGeoPoint {
    return {
      __type: "geopoint",
      value: { latitude: this.latitude, longitude: this.longitude },
    };
  }

  /** @internal シリアライズ形式から復元 */
  static fromSerialized(value: SerializedGeoPoint["value"]): GeoPoint {
    return new GeoPoint(value.latitude, value.longitude);
  }
}
