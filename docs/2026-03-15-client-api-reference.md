# Firestore クライアントライブラリ API リファレンス

ローカルFirestoreクローンで実装が必要な関数・クラス・型の一覧。
Web Modular SDK (v9+) と Admin SDK (Node.js) の両方をカバーする。

---

## Part 1: Web Modular SDK (`firebase/firestore`)

### 1. Firestore インスタンス初期化

```typescript
function getFirestore(): Firestore;
function getFirestore(app: FirebaseApp): Firestore;
function getFirestore(databaseId: string): Firestore;
function getFirestore(app: FirebaseApp, databaseId: string): Firestore;

function initializeFirestore(
  app: FirebaseApp,
  settings: FirestoreSettings,
  databaseId?: string
): Firestore;

function connectFirestoreEmulator(
  firestore: Firestore,
  host: string,
  port: number,
  options?: { mockUserToken?: EmulatorMockTokenOptions | string }
): void;

function terminate(firestore: Firestore): Promise<void>;
function enableNetwork(firestore: Firestore): Promise<void>;
function disableNetwork(firestore: Firestore): Promise<void>;
function waitForPendingWrites(firestore: Firestore): Promise<void>;
function setLogLevel(logLevel: LogLevel): void;
```

**`Firestore` クラス:**

```typescript
class Firestore {
  type: 'firestore-lite' | 'firestore';
  get app(): FirebaseApp;
  toJSON(): object;
}
```

**`FirestoreSettings` インターフェース:**

```typescript
interface FirestoreSettings {
  cacheSizeBytes?: number;
  localCache?: FirestoreLocalCache;
  experimentalForceLongPolling?: boolean;
  experimentalAutoDetectLongPolling?: boolean;
  experimentalLongPollingOptions?: ExperimentalLongPollingOptions;
  host?: string;
  ssl?: boolean;
  ignoreUndefinedProperties?: boolean;
}
```

### 2. ドキュメント・コレクション参照

```typescript
// doc() オーバーロード
function doc(
  firestore: Firestore,
  path: string,
  ...pathSegments: string[]
): DocumentReference<DocumentData, DocumentData>;

function doc<AppModelType, DbModelType extends DocumentData>(
  reference: CollectionReference<AppModelType, DbModelType>,
  path?: string,
  ...pathSegments: string[]
): DocumentReference<AppModelType, DbModelType>;

function doc<AppModelType, DbModelType extends DocumentData>(
  reference: DocumentReference<AppModelType, DbModelType>,
  path: string,
  ...pathSegments: string[]
): DocumentReference<DocumentData, DocumentData>;

// collection() オーバーロード
function collection(
  firestore: Firestore,
  path: string,
  ...pathSegments: string[]
): CollectionReference<DocumentData, DocumentData>;

function collection<AppModelType, DbModelType extends DocumentData>(
  reference: CollectionReference<AppModelType, DbModelType>,
  path: string,
  ...pathSegments: string[]
): CollectionReference<DocumentData, DocumentData>;

function collection<AppModelType, DbModelType extends DocumentData>(
  reference: DocumentReference<AppModelType, DbModelType>,
  path: string,
  ...pathSegments: string[]
): CollectionReference<DocumentData, DocumentData>;

// コレクショングループ
function collectionGroup(
  firestore: Firestore,
  collectionId: string
): Query<DocumentData, DocumentData>;

// ドキュメントIDセンチネル
function documentId(): FieldPath;
```

**`DocumentReference` クラス:**

```typescript
class DocumentReference<
  AppModelType = DocumentData,
  DbModelType extends DocumentData = DocumentData
> {
  readonly converter: FirestoreDataConverter<AppModelType, DbModelType> | null;
  readonly type: "document";
  readonly firestore: Firestore;
  get id(): string;
  get path(): string;
  get parent(): CollectionReference<AppModelType, DbModelType>;
  withConverter<NewAppModelType, NewDbModelType extends DocumentData>(
    converter: FirestoreDataConverter<NewAppModelType, NewDbModelType>
  ): DocumentReference<NewAppModelType, NewDbModelType>;
  withConverter(converter: null): DocumentReference<DocumentData, DocumentData>;
}
```

**`CollectionReference` クラス:**

```typescript
class CollectionReference<
  AppModelType = DocumentData,
  DbModelType extends DocumentData = DocumentData
> extends Query<AppModelType, DbModelType> {
  readonly type: "collection";
  get id(): string;
  get path(): string;
  get parent(): DocumentReference<DocumentData, DocumentData> | null;
  withConverter<NewAppModelType, NewDbModelType extends DocumentData>(
    converter: FirestoreDataConverter<NewAppModelType, NewDbModelType>
  ): CollectionReference<NewAppModelType, NewDbModelType>;
  withConverter(converter: null): CollectionReference<DocumentData, DocumentData>;
}
```

### 3. CRUD操作

```typescript
// 読み取り
function getDoc<AppModelType, DbModelType extends DocumentData>(
  reference: DocumentReference<AppModelType, DbModelType>
): Promise<DocumentSnapshot<AppModelType, DbModelType>>;

function getDocFromCache<AppModelType, DbModelType extends DocumentData>(
  reference: DocumentReference<AppModelType, DbModelType>
): Promise<DocumentSnapshot<AppModelType, DbModelType>>;

function getDocFromServer<AppModelType, DbModelType extends DocumentData>(
  reference: DocumentReference<AppModelType, DbModelType>
): Promise<DocumentSnapshot<AppModelType, DbModelType>>;

function getDocs<AppModelType, DbModelType extends DocumentData>(
  query: Query<AppModelType, DbModelType>
): Promise<QuerySnapshot<AppModelType, DbModelType>>;

function getDocsFromCache<AppModelType, DbModelType extends DocumentData>(
  query: Query<AppModelType, DbModelType>
): Promise<QuerySnapshot<AppModelType, DbModelType>>;

function getDocsFromServer<AppModelType, DbModelType extends DocumentData>(
  query: Query<AppModelType, DbModelType>
): Promise<QuerySnapshot<AppModelType, DbModelType>>;

// 作成
function addDoc<AppModelType, DbModelType extends DocumentData>(
  reference: CollectionReference<AppModelType, DbModelType>,
  data: WithFieldValue<AppModelType>
): Promise<DocumentReference<AppModelType, DbModelType>>;

// 作成 or 上書き
function setDoc<AppModelType, DbModelType extends DocumentData>(
  reference: DocumentReference<AppModelType, DbModelType>,
  data: WithFieldValue<AppModelType>
): Promise<void>;

function setDoc<AppModelType, DbModelType extends DocumentData>(
  reference: DocumentReference<AppModelType, DbModelType>,
  data: PartialWithFieldValue<AppModelType>,
  options: SetOptions
): Promise<void>;

// 更新
function updateDoc<AppModelType, DbModelType extends DocumentData>(
  reference: DocumentReference<AppModelType, DbModelType>,
  data: UpdateData<DbModelType>
): Promise<void>;

function updateDoc<AppModelType, DbModelType extends DocumentData>(
  reference: DocumentReference<AppModelType, DbModelType>,
  field: string | FieldPath,
  value: unknown,
  ...moreFieldsAndValues: unknown[]
): Promise<void>;

// 削除
function deleteDoc<AppModelType, DbModelType extends DocumentData>(
  reference: DocumentReference<AppModelType, DbModelType>
): Promise<void>;
```

### 4. クエリ構築

```typescript
// クエリ合成
function query<AppModelType, DbModelType extends DocumentData>(
  query: Query<AppModelType, DbModelType>,
  compositeFilter: QueryCompositeFilterConstraint,
  ...queryConstraints: QueryNonFilterConstraint[]
): Query<AppModelType, DbModelType>;

function query<AppModelType, DbModelType extends DocumentData>(
  query: Query<AppModelType, DbModelType>,
  ...queryConstraints: QueryConstraint[]
): Query<AppModelType, DbModelType>;

// フィルタ
function where(
  fieldPath: string | FieldPath,
  opStr: WhereFilterOp,
  value: unknown
): QueryFieldFilterConstraint;

function and(
  ...queryConstraints: QueryFilterConstraint[]
): QueryCompositeFilterConstraint;

function or(
  ...queryConstraints: QueryFilterConstraint[]
): QueryCompositeFilterConstraint;

// ソート
function orderBy(
  fieldPath: string | FieldPath,
  directionStr?: OrderByDirection
): QueryOrderByConstraint;

// リミット
function limit(limit: number): QueryLimitConstraint;
function limitToLast(limit: number): QueryLimitConstraint;

// カーソル
function startAt<AppModelType, DbModelType extends DocumentData>(
  snapshot: DocumentSnapshot<AppModelType, DbModelType>
): QueryStartAtConstraint;
function startAt(...fieldValues: unknown[]): QueryStartAtConstraint;

function startAfter<AppModelType, DbModelType extends DocumentData>(
  snapshot: DocumentSnapshot<AppModelType, DbModelType>
): QueryStartAtConstraint;
function startAfter(...fieldValues: unknown[]): QueryStartAtConstraint;

function endAt<AppModelType, DbModelType extends DocumentData>(
  snapshot: DocumentSnapshot<AppModelType, DbModelType>
): QueryEndAtConstraint;
function endAt(...fieldValues: unknown[]): QueryEndAtConstraint;

function endBefore<AppModelType, DbModelType extends DocumentData>(
  snapshot: DocumentSnapshot<AppModelType, DbModelType>
): QueryEndAtConstraint;
function endBefore(...fieldValues: unknown[]): QueryEndAtConstraint;
```

**`Query` クラス:**

```typescript
class Query<
  AppModelType = DocumentData,
  DbModelType extends DocumentData = DocumentData
> {
  readonly converter: FirestoreDataConverter<AppModelType, DbModelType> | null;
  readonly type: 'query' | 'collection';
  readonly firestore: Firestore;
  withConverter<NewAppModelType, NewDbModelType extends DocumentData>(
    converter: FirestoreDataConverter<NewAppModelType, NewDbModelType>
  ): Query<NewAppModelType, NewDbModelType>;
  withConverter(converter: null): Query<DocumentData, DocumentData>;
}
```

**クエリ関連型:**

```typescript
type WhereFilterOp =
  | '<' | '<=' | '==' | '!=' | '>=' | '>'
  | 'array-contains' | 'in' | 'not-in' | 'array-contains-any';

type OrderByDirection = 'desc' | 'asc';

type DocumentChangeType = 'added' | 'removed' | 'modified';

class QueryConstraint {
  abstract readonly type: QueryConstraintType;
}

class QueryFieldFilterConstraint extends QueryConstraint {
  readonly type: "where";
}

class QueryOrderByConstraint extends QueryConstraint {
  readonly type: "orderBy";
}

class QueryLimitConstraint extends QueryConstraint {
  readonly type: "limit" | "limitToLast";
}

class QueryStartAtConstraint extends QueryConstraint {
  readonly type: "startAt" | "startAfter";
}

class QueryEndAtConstraint extends QueryConstraint {
  readonly type: "endBefore" | "endAt";
}

class QueryCompositeFilterConstraint {
  readonly type: 'or' | 'and';
}
```

### 5. 集計クエリ

```typescript
function count(): AggregateField<number>;
function sum(field: string | FieldPath): AggregateField<number>;
function average(field: string | FieldPath): AggregateField<number | null>;

function getCountFromServer<AppModelType, DbModelType extends DocumentData>(
  query: Query<AppModelType, DbModelType>
): Promise<AggregateQuerySnapshot<
  { count: AggregateField<number> }, AppModelType, DbModelType
>>;

function getAggregateFromServer<
  AggregateSpecType extends AggregateSpec,
  AppModelType,
  DbModelType extends DocumentData
>(
  query: Query<AppModelType, DbModelType>,
  aggregateSpec: AggregateSpecType
): Promise<AggregateQuerySnapshot<AggregateSpecType, AppModelType, DbModelType>>;
```

**集計関連クラス:**

```typescript
class AggregateField<T> {
  readonly type: "AggregateField";
  readonly aggregateType: AggregateType;
}

class AggregateQuerySnapshot<
  AggregateSpecType extends AggregateSpec,
  AppModelType = DocumentData,
  DbModelType extends DocumentData = DocumentData
> {
  readonly type: "AggregateQuerySnapshot";
  readonly query: Query<AppModelType, DbModelType>;
  data(): AggregateSpecData<AggregateSpecType>;
}

interface AggregateSpec {
  [field: string]: AggregateFieldType;
}

type AggregateType = 'count' | 'avg' | 'sum';
```

### 6. バッチ・トランザクション

```typescript
function writeBatch(firestore: Firestore): WriteBatch;

function runTransaction<T>(
  firestore: Firestore,
  updateFunction: (transaction: Transaction) => Promise<T>,
  options?: TransactionOptions
): Promise<T>;
```

**`WriteBatch` クラス:**

```typescript
class WriteBatch {
  set<AppModelType, DbModelType extends DocumentData>(
    documentRef: DocumentReference<AppModelType, DbModelType>,
    data: WithFieldValue<AppModelType>
  ): WriteBatch;

  set<AppModelType, DbModelType extends DocumentData>(
    documentRef: DocumentReference<AppModelType, DbModelType>,
    data: PartialWithFieldValue<AppModelType>,
    options: SetOptions
  ): WriteBatch;

  update<AppModelType, DbModelType extends DocumentData>(
    documentRef: DocumentReference<AppModelType, DbModelType>,
    data: UpdateData<DbModelType>
  ): WriteBatch;

  update<AppModelType, DbModelType extends DocumentData>(
    documentRef: DocumentReference<AppModelType, DbModelType>,
    field: string | FieldPath,
    value: unknown,
    ...moreFieldsAndValues: unknown[]
  ): WriteBatch;

  delete<AppModelType, DbModelType extends DocumentData>(
    documentRef: DocumentReference<AppModelType, DbModelType>
  ): WriteBatch;

  commit(): Promise<void>;
}
```

**`Transaction` クラス:**

```typescript
class Transaction {
  get<AppModelType, DbModelType extends DocumentData>(
    documentRef: DocumentReference<AppModelType, DbModelType>
  ): Promise<DocumentSnapshot<AppModelType, DbModelType>>;

  set<AppModelType, DbModelType extends DocumentData>(
    documentRef: DocumentReference<AppModelType, DbModelType>,
    data: WithFieldValue<AppModelType>
  ): this;

  set<AppModelType, DbModelType extends DocumentData>(
    documentRef: DocumentReference<AppModelType, DbModelType>,
    data: PartialWithFieldValue<AppModelType>,
    options: SetOptions
  ): this;

  update<AppModelType, DbModelType extends DocumentData>(
    documentRef: DocumentReference<AppModelType, DbModelType>,
    data: UpdateData<DbModelType>
  ): this;

  update<AppModelType, DbModelType extends DocumentData>(
    documentRef: DocumentReference<AppModelType, DbModelType>,
    field: string | FieldPath,
    value: unknown,
    ...moreFieldsAndValues: unknown[]
  ): this;

  delete<AppModelType, DbModelType extends DocumentData>(
    documentRef: DocumentReference<AppModelType, DbModelType>
  ): this;
}
```

**`TransactionOptions` インターフェース:**

```typescript
interface TransactionOptions {
  readonly maxAttempts?: number;
}
```

### 7. リアルタイムリスナー

```typescript
// ドキュメントリスナー
function onSnapshot<AppModelType, DbModelType extends DocumentData>(
  reference: DocumentReference<AppModelType, DbModelType>,
  observer: {
    next?: (snapshot: DocumentSnapshot<AppModelType, DbModelType>) => void;
    error?: (error: FirestoreError) => void;
    complete?: () => void;
  }
): Unsubscribe;

function onSnapshot<AppModelType, DbModelType extends DocumentData>(
  reference: DocumentReference<AppModelType, DbModelType>,
  options: SnapshotListenOptions,
  observer: {
    next?: (snapshot: DocumentSnapshot<AppModelType, DbModelType>) => void;
    error?: (error: FirestoreError) => void;
    complete?: () => void;
  }
): Unsubscribe;

function onSnapshot<AppModelType, DbModelType extends DocumentData>(
  reference: DocumentReference<AppModelType, DbModelType>,
  onNext: (snapshot: DocumentSnapshot<AppModelType, DbModelType>) => void,
  onError?: (error: FirestoreError) => void,
  onCompletion?: () => void
): Unsubscribe;

function onSnapshot<AppModelType, DbModelType extends DocumentData>(
  reference: DocumentReference<AppModelType, DbModelType>,
  options: SnapshotListenOptions,
  onNext: (snapshot: DocumentSnapshot<AppModelType, DbModelType>) => void,
  onError?: (error: FirestoreError) => void,
  onCompletion?: () => void
): Unsubscribe;

// クエリリスナー
function onSnapshot<AppModelType, DbModelType extends DocumentData>(
  query: Query<AppModelType, DbModelType>,
  observer: {
    next?: (snapshot: QuerySnapshot<AppModelType, DbModelType>) => void;
    error?: (error: FirestoreError) => void;
    complete?: () => void;
  }
): Unsubscribe;

function onSnapshot<AppModelType, DbModelType extends DocumentData>(
  query: Query<AppModelType, DbModelType>,
  options: SnapshotListenOptions,
  observer: {
    next?: (snapshot: QuerySnapshot<AppModelType, DbModelType>) => void;
    error?: (error: FirestoreError) => void;
    complete?: () => void;
  }
): Unsubscribe;

function onSnapshot<AppModelType, DbModelType extends DocumentData>(
  query: Query<AppModelType, DbModelType>,
  onNext: (snapshot: QuerySnapshot<AppModelType, DbModelType>) => void,
  onError?: (error: FirestoreError) => void,
  onCompletion?: () => void
): Unsubscribe;

function onSnapshot<AppModelType, DbModelType extends DocumentData>(
  query: Query<AppModelType, DbModelType>,
  options: SnapshotListenOptions,
  onNext: (snapshot: QuerySnapshot<AppModelType, DbModelType>) => void,
  onError?: (error: FirestoreError) => void,
  onCompletion?: () => void
): Unsubscribe;

// 同期リスナー
function onSnapshotsInSync(
  firestore: Firestore,
  observer: {
    next?: (value: void) => void;
    error?: (error: FirestoreError) => void;
    complete?: () => void;
  }
): Unsubscribe;

function onSnapshotsInSync(
  firestore: Firestore,
  onSync: () => void
): Unsubscribe;
```

**リスナー関連型:**

```typescript
type Unsubscribe = () => void;

interface SnapshotListenOptions {
  includeMetadataChanges?: boolean;
  source?: ListenSource;
}

type ListenSource = 'default' | 'cache';
```

### 8. FieldValue ヘルパー

```typescript
function serverTimestamp(): FieldValue;
function increment(n: number): FieldValue;
function arrayUnion(...elements: unknown[]): FieldValue;
function arrayRemove(...elements: unknown[]): FieldValue;
function deleteField(): FieldValue;
function vector(value?: number[]): VectorValue;
```

**`FieldValue` クラス:**

```typescript
class FieldValue {
  abstract isEqual(other: FieldValue): boolean;
}
```

### 9. スナップショット型

**`DocumentSnapshot` クラス:**

```typescript
class DocumentSnapshot<
  AppModelType = DocumentData,
  DbModelType extends DocumentData = DocumentData
> {
  readonly metadata: SnapshotMetadata;
  exists(): this is QueryDocumentSnapshot<AppModelType, DbModelType>;
  data(options?: SnapshotOptions): AppModelType | undefined;
  get(fieldPath: string | FieldPath, options?: SnapshotOptions): any;
  get id(): string;
  get ref(): DocumentReference<AppModelType, DbModelType>;
  toJSON(): object;
}
```

**`QueryDocumentSnapshot` クラス:**

```typescript
class QueryDocumentSnapshot<
  AppModelType = DocumentData,
  DbModelType extends DocumentData = DocumentData
> extends DocumentSnapshot<AppModelType, DbModelType> {
  data(options?: SnapshotOptions): AppModelType; // undefinedにならない
}
```

**`QuerySnapshot` クラス:**

```typescript
class QuerySnapshot<
  AppModelType = DocumentData,
  DbModelType extends DocumentData = DocumentData
> {
  readonly metadata: SnapshotMetadata;
  readonly query: Query<AppModelType, DbModelType>;
  get docs(): Array<QueryDocumentSnapshot<AppModelType, DbModelType>>;
  get size(): number;
  get empty(): boolean;
  forEach(
    callback: (result: QueryDocumentSnapshot<AppModelType, DbModelType>) => void,
    thisArg?: unknown
  ): void;
  docChanges(
    options?: SnapshotListenOptions
  ): Array<DocumentChange<AppModelType, DbModelType>>;
  toJSON(): object;
}
```

**`SnapshotMetadata` クラス:**

```typescript
class SnapshotMetadata {
  readonly hasPendingWrites: boolean;
  readonly fromCache: boolean;
  isEqual(other: SnapshotMetadata): boolean;
}
```

**`DocumentChange` インターフェース:**

```typescript
interface DocumentChange<
  AppModelType = DocumentData,
  DbModelType extends DocumentData = DocumentData
> {
  readonly type: DocumentChangeType;
  readonly doc: QueryDocumentSnapshot<AppModelType, DbModelType>;
  readonly oldIndex: number;
  readonly newIndex: number;
}

type DocumentChangeType = 'added' | 'removed' | 'modified';
```

**`SnapshotOptions` インターフェース:**

```typescript
interface SnapshotOptions {
  serverTimestamps?: 'estimate' | 'previous' | 'none';
}
```

### 10. 等価比較

```typescript
function refEqual<AppModelType, DbModelType extends DocumentData>(
  left: DocumentReference<AppModelType, DbModelType> | CollectionReference<AppModelType, DbModelType>,
  right: DocumentReference<AppModelType, DbModelType> | CollectionReference<AppModelType, DbModelType>
): boolean;

function queryEqual<AppModelType, DbModelType extends DocumentData>(
  left: Query<AppModelType, DbModelType>,
  right: Query<AppModelType, DbModelType>
): boolean;

function snapshotEqual<AppModelType, DbModelType extends DocumentData>(
  left: DocumentSnapshot<AppModelType, DbModelType> | QuerySnapshot<AppModelType, DbModelType>,
  right: DocumentSnapshot<AppModelType, DbModelType> | QuerySnapshot<AppModelType, DbModelType>
): boolean;
```

### 11. ユーティリティクラス

**`Timestamp` クラス:**

```typescript
class Timestamp {
  constructor(seconds: number, nanoseconds: number);
  static now(): Timestamp;
  static fromDate(date: Date): Timestamp;
  static fromMillis(milliseconds: number): Timestamp;
  readonly seconds: number;
  readonly nanoseconds: number;
  toDate(): Date;
  toMillis(): number;
  isEqual(other: Timestamp): boolean;
  valueOf(): string;
}
```

**`GeoPoint` クラス:**

```typescript
class GeoPoint {
  constructor(latitude: number, longitude: number);
  get latitude(): number;
  get longitude(): number;
  isEqual(other: GeoPoint): boolean;
  toJSON(): { latitude: number; longitude: number };
}
```

**`Bytes` クラス:**

```typescript
class Bytes {
  static fromBase64String(base64: string): Bytes;
  static fromUint8Array(array: Uint8Array): Bytes;
  toBase64(): string;
  toUint8Array(): Uint8Array;
  toString(): string;
  isEqual(other: Bytes): boolean;
}
```

**`FieldPath` クラス:**

```typescript
class FieldPath {
  constructor(...fieldNames: string[]);
  isEqual(other: FieldPath): boolean;
}
```

### 12. 永続化・キャッシュ（Web固有）

```typescript
// レガシー永続化
function enableIndexedDbPersistence(
  firestore: Firestore,
  persistenceSettings?: PersistenceSettings
): Promise<void>;

function enableMultiTabIndexedDbPersistence(firestore: Firestore): Promise<void>;
function clearIndexedDbPersistence(firestore: Firestore): Promise<void>;

// モダンキャッシュ設定
function memoryLocalCache(settings?: MemoryCacheSettings): MemoryLocalCache;
function memoryEagerGarbageCollector(): MemoryEagerGarbageCollector;
function memoryLruGarbageCollector(
  settings?: { cacheSizeBytes?: number }
): MemoryLruGarbageCollector;
function persistentLocalCache(settings?: PersistentCacheSettings): PersistentLocalCache;
function persistentSingleTabManager(
  settings?: PersistentSingleTabManagerSettings
): PersistentSingleTabManager;
function persistentMultipleTabManager(): PersistentMultipleTabManager;

// インデックス管理
function getPersistentCacheIndexManager(
  firestore: Firestore
): PersistentCacheIndexManager | null;
function deleteAllPersistentCacheIndexes(
  indexManager: PersistentCacheIndexManager
): void;
function enablePersistentCacheIndexAutoCreation(
  indexManager: PersistentCacheIndexManager
): void;
function disablePersistentCacheIndexAutoCreation(
  indexManager: PersistentCacheIndexManager
): void;

const CACHE_SIZE_UNLIMITED: -1;
```

### 13. バンドル

```typescript
function loadBundle(
  firestore: Firestore,
  bundleData: ReadableStream<Uint8Array> | ArrayBuffer | string
): LoadBundleTask;

function namedQuery(
  firestore: Firestore,
  name: string
): Promise<Query | null>;
```

### 14. データコンバーター・型ヘルパー

```typescript
interface FirestoreDataConverter<
  AppModelType,
  DbModelType extends DocumentData = DocumentData
> {
  toFirestore(modelObject: WithFieldValue<AppModelType>): WithFieldValue<DbModelType>;
  toFirestore(
    modelObject: PartialWithFieldValue<AppModelType>,
    options: SetOptions
  ): PartialWithFieldValue<DbModelType>;
  fromFirestore(
    snapshot: QueryDocumentSnapshot<DocumentData, DocumentData>,
    options?: SnapshotOptions
  ): AppModelType;
}

interface DocumentData {
  [field: string]: any;
}

type SetOptions =
  | { merge: true }
  | { mergeFields: Array<string | FieldPath> };

type WithFieldValue<T> =
  T extends Primitive ? T :
  T extends {} ? { [K in keyof T]: WithFieldValue<T[K]> | FieldValue } :
  never;

type PartialWithFieldValue<T> =
  Partial<T> | (
    T extends Primitive ? T :
    T extends {} ? { [K in keyof T]?: PartialWithFieldValue<T[K]> | FieldValue } :
    never
  );

type UpdateData<T> =
  T extends Primitive ? never :
  T extends {} ? { [K in keyof T]?: UpdateData<T[K]> | FieldValue } & NestedUpdateFields<T> :
  never;

type Primitive = string | number | boolean | undefined | null;
```

### 15. エラー型

```typescript
class FirestoreError extends FirebaseError {
  readonly code: FirestoreErrorCode;
  readonly message: string;
  readonly stack?: string;
}

type FirestoreErrorCode =
  | 'cancelled' | 'unknown' | 'invalid-argument' | 'deadline-exceeded'
  | 'not-found' | 'already-exists' | 'permission-denied' | 'resource-exhausted'
  | 'failed-precondition' | 'aborted' | 'out-of-range' | 'unimplemented'
  | 'internal' | 'unavailable' | 'data-loss' | 'unauthenticated';
```

---

## Part 2: Admin SDK (`firebase-admin/firestore`)

Admin SDKは `@google-cloud/firestore` をラップしており、Web SDKの関数型APIとは異なる**クラスベースのオブジェクト指向API**を採用している。

### 1. 初期化

```typescript
function getFirestore(): Firestore;
function getFirestore(app: App): Firestore;
function getFirestore(databaseId: string): Firestore;
function getFirestore(app: App, databaseId: string): Firestore;

function initializeFirestore(
  app: App,
  settings?: FirestoreSettings
): Firestore;

function initializeFirestore(
  app: App,
  settings: FirestoreSettings,
  databaseId: string
): Firestore;
```

### 2. Firestore クラス

```typescript
class Firestore {
  constructor(settings?: Settings);
  settings(settings: Settings): void;
  get databaseId(): string;
  collection(collectionPath: string): CollectionReference;
  doc(documentPath: string): DocumentReference;
  collectionGroup(collectionId: string): CollectionGroup;
  getAll<AppModelType, DbModelType extends DocumentData>(
    ...documentRefsOrReadOptions: Array<
      DocumentReference<AppModelType, DbModelType> | ReadOptions
    >
  ): Promise<Array<DocumentSnapshot<AppModelType, DbModelType>>>;
  listCollections(): Promise<Array<CollectionReference>>;
  runTransaction<T>(
    updateFunction: (transaction: Transaction) => Promise<T>,
    transactionOptions?: ReadWriteTransactionOptions | ReadOnlyTransactionOptions
  ): Promise<T>;
  batch(): WriteBatch;
  bulkWriter(options?: BulkWriterOptions): BulkWriter;
  bundle(bundleId?: string): BundleBuilder;
  recursiveDelete(
    ref: CollectionReference | DocumentReference,
    bulkWriter?: BulkWriter
  ): Promise<void>;
  terminate(): Promise<void>;
  toJSON(): object;
}
```

**`Settings` インターフェース:**

```typescript
interface Settings {
  projectId?: string;
  databaseId?: string;
  host?: string;
  port?: number;
  keyFilename?: string;
  credentials?: { client_email?: string; private_key?: string };
  ssl?: boolean;
  maxIdleChannels?: number;
  useBigInt?: boolean;
  ignoreUndefinedProperties?: boolean;
  preferRest?: boolean;
}
```

### 3. DocumentReference（Admin）

```typescript
class DocumentReference<
  AppModelType = DocumentData,
  DbModelType extends DocumentData = DocumentData
> {
  readonly id: string;
  readonly firestore: Firestore;
  readonly parent: CollectionReference<AppModelType, DbModelType>;
  readonly path: string;
  collection(collectionPath: string): CollectionReference;
  listCollections(): Promise<Array<CollectionReference>>;
  create(data: WithFieldValue<AppModelType>): Promise<WriteResult>;
  set(data: WithFieldValue<AppModelType>): Promise<WriteResult>;
  set(
    data: PartialWithFieldValue<AppModelType>,
    options: SetOptions
  ): Promise<WriteResult>;
  update(
    data: UpdateData<DbModelType>,
    precondition?: Precondition
  ): Promise<WriteResult>;
  update(
    field: string | FieldPath,
    value: any,
    ...moreFieldsOrPrecondition: any[]
  ): Promise<WriteResult>;
  delete(precondition?: Precondition): Promise<WriteResult>;
  get(): Promise<DocumentSnapshot<AppModelType, DbModelType>>;
  onSnapshot(
    onNext: (snapshot: DocumentSnapshot<AppModelType, DbModelType>) => void,
    onError?: (error: Error) => void
  ): () => void;
  isEqual(other: DocumentReference<AppModelType, DbModelType>): boolean;
  withConverter<NewAppModelType, NewDbModelType extends DocumentData>(
    converter: FirestoreDataConverter<NewAppModelType, NewDbModelType>
  ): DocumentReference<NewAppModelType, NewDbModelType>;
  withConverter(converter: null): DocumentReference;
}
```

### 4. CollectionReference（Admin）

```typescript
class CollectionReference<
  AppModelType = DocumentData,
  DbModelType extends DocumentData = DocumentData
> extends Query<AppModelType, DbModelType> {
  readonly id: string;
  readonly parent: DocumentReference | null;
  readonly path: string;
  doc(): DocumentReference<AppModelType, DbModelType>;
  doc(documentPath: string): DocumentReference<AppModelType, DbModelType>;
  add(
    data: WithFieldValue<AppModelType>
  ): Promise<DocumentReference<AppModelType, DbModelType>>;
  listDocuments(): Promise<Array<DocumentReference<AppModelType, DbModelType>>>;
  isEqual(other: CollectionReference<AppModelType, DbModelType>): boolean;
  withConverter<NewAppModelType, NewDbModelType extends DocumentData>(
    converter: FirestoreDataConverter<NewAppModelType, NewDbModelType>
  ): CollectionReference<NewAppModelType, NewDbModelType>;
  withConverter(converter: null): CollectionReference;
}
```

### 5. Query（Admin）— メソッドチェーンスタイル

```typescript
class Query<
  AppModelType = DocumentData,
  DbModelType extends DocumentData = DocumentData
> {
  readonly firestore: Firestore;
  where(
    fieldPath: string | FieldPath,
    opStr: WhereFilterOp,
    value: any
  ): Query<AppModelType, DbModelType>;
  where(filter: Filter): Query<AppModelType, DbModelType>;
  orderBy(
    fieldPath: string | FieldPath,
    directionStr?: OrderByDirection
  ): Query<AppModelType, DbModelType>;
  limit(limit: number): Query<AppModelType, DbModelType>;
  limitToLast(limit: number): Query<AppModelType, DbModelType>;
  offset(offset: number): Query<AppModelType, DbModelType>;
  select(...field: (string | FieldPath)[]): Query;
  startAt(snapshot: DocumentSnapshot): Query<AppModelType, DbModelType>;
  startAt(...fieldValues: any[]): Query<AppModelType, DbModelType>;
  startAfter(snapshot: DocumentSnapshot): Query<AppModelType, DbModelType>;
  startAfter(...fieldValues: any[]): Query<AppModelType, DbModelType>;
  endBefore(snapshot: DocumentSnapshot): Query<AppModelType, DbModelType>;
  endBefore(...fieldValues: any[]): Query<AppModelType, DbModelType>;
  endAt(snapshot: DocumentSnapshot): Query<AppModelType, DbModelType>;
  endAt(...fieldValues: any[]): Query<AppModelType, DbModelType>;
  get(): Promise<QuerySnapshot<AppModelType, DbModelType>>;
  stream(): NodeJS.ReadableStream;
  onSnapshot(
    onNext: (snapshot: QuerySnapshot<AppModelType, DbModelType>) => void,
    onError?: (error: Error) => void
  ): () => void;
  count(): AggregateQuery<
    { count: AggregateField<number> }, AppModelType, DbModelType
  >;
  aggregate<T extends AggregateSpec>(
    aggregateSpec: T
  ): AggregateQuery<T, AppModelType, DbModelType>;
  findNearest(
    vectorField: string | FieldPath,
    queryVector: VectorValue | Array<number>,
    options: {
      limit: number;
      distanceMeasure: 'EUCLIDEAN' | 'COSINE' | 'DOT_PRODUCT';
    }
  ): VectorQuery<AppModelType, DbModelType>;
  isEqual(other: Query<AppModelType, DbModelType>): boolean;
  withConverter<NewAppModelType, NewDbModelType extends DocumentData>(
    converter: FirestoreDataConverter<NewAppModelType, NewDbModelType>
  ): Query<NewAppModelType, NewDbModelType>;
  withConverter(converter: null): Query;
}
```

**`Filter` クラス（Admin専用の合成フィルタ）:**

```typescript
class Filter {
  static where(
    fieldPath: string | FieldPath,
    opStr: WhereFilterOp,
    value: any
  ): Filter;
  static and(...filters: Filter[]): Filter;
  static or(...filters: Filter[]): Filter;
}
```

### 6. Transaction（Admin）

```typescript
class Transaction {
  get<AppModelType, DbModelType extends DocumentData>(
    documentRef: DocumentReference<AppModelType, DbModelType>
  ): Promise<DocumentSnapshot<AppModelType, DbModelType>>;

  get<AppModelType, DbModelType extends DocumentData>(
    query: Query<AppModelType, DbModelType>
  ): Promise<QuerySnapshot<AppModelType, DbModelType>>;

  get<AggregateSpecType extends AggregateSpec, AppModelType, DbModelType extends DocumentData>(
    aggregateQuery: AggregateQuery<AggregateSpecType, AppModelType, DbModelType>
  ): Promise<AggregateQuerySnapshot<AggregateSpecType, AppModelType, DbModelType>>;

  getAll<AppModelType, DbModelType extends DocumentData>(
    ...documentRefsOrReadOptions: Array<
      DocumentReference<AppModelType, DbModelType> | ReadOptions
    >
  ): Promise<Array<DocumentSnapshot<AppModelType, DbModelType>>>;

  create<AppModelType, DbModelType extends DocumentData>(
    documentRef: DocumentReference<AppModelType, DbModelType>,
    data: WithFieldValue<AppModelType>
  ): Transaction;

  set<AppModelType, DbModelType extends DocumentData>(
    documentRef: DocumentReference<AppModelType, DbModelType>,
    data: WithFieldValue<AppModelType>
  ): Transaction;

  set<AppModelType, DbModelType extends DocumentData>(
    documentRef: DocumentReference<AppModelType, DbModelType>,
    data: PartialWithFieldValue<AppModelType>,
    options: SetOptions
  ): Transaction;

  update<AppModelType, DbModelType extends DocumentData>(
    documentRef: DocumentReference<AppModelType, DbModelType>,
    data: UpdateData<DbModelType>,
    precondition?: Precondition
  ): Transaction;

  update(
    documentRef: DocumentReference,
    field: string | FieldPath,
    value: any,
    ...fieldsOrPrecondition: any[]
  ): Transaction;

  delete(
    documentRef: DocumentReference,
    precondition?: Precondition
  ): Transaction;
}
```

**トランザクションオプション（Admin）:**

```typescript
interface ReadWriteTransactionOptions {
  readOnly?: false;
  maxAttempts?: number;
}

interface ReadOnlyTransactionOptions {
  readOnly: true;
  readTime?: Timestamp;
}
```

### 7. WriteBatch（Admin）

```typescript
class WriteBatch {
  create<AppModelType, DbModelType extends DocumentData>(
    documentRef: DocumentReference<AppModelType, DbModelType>,
    data: WithFieldValue<AppModelType>
  ): WriteBatch;

  set<AppModelType, DbModelType extends DocumentData>(
    documentRef: DocumentReference<AppModelType, DbModelType>,
    data: WithFieldValue<AppModelType>
  ): WriteBatch;

  set<AppModelType, DbModelType extends DocumentData>(
    documentRef: DocumentReference<AppModelType, DbModelType>,
    data: PartialWithFieldValue<AppModelType>,
    options: SetOptions
  ): WriteBatch;

  update<AppModelType, DbModelType extends DocumentData>(
    documentRef: DocumentReference<AppModelType, DbModelType>,
    data: UpdateData<DbModelType>,
    precondition?: Precondition
  ): WriteBatch;

  update(
    documentRef: DocumentReference,
    field: string | FieldPath,
    value: any,
    ...fieldsOrPrecondition: any[]
  ): WriteBatch;

  delete(
    documentRef: DocumentReference,
    precondition?: Precondition
  ): WriteBatch;

  commit(): Promise<WriteResult[]>;
}
```

### 8. BulkWriter（Admin専用）

```typescript
class BulkWriter {
  create<AppModelType, DbModelType extends DocumentData>(
    documentRef: DocumentReference<AppModelType, DbModelType>,
    data: WithFieldValue<AppModelType>
  ): Promise<WriteResult>;

  set<AppModelType, DbModelType extends DocumentData>(
    documentRef: DocumentReference<AppModelType, DbModelType>,
    data: WithFieldValue<AppModelType>
  ): Promise<WriteResult>;

  set<AppModelType, DbModelType extends DocumentData>(
    documentRef: DocumentReference<AppModelType, DbModelType>,
    data: PartialWithFieldValue<AppModelType>,
    options: SetOptions
  ): Promise<WriteResult>;

  update<AppModelType, DbModelType extends DocumentData>(
    documentRef: DocumentReference<AppModelType, DbModelType>,
    data: UpdateData<DbModelType>,
    precondition?: Precondition
  ): Promise<WriteResult>;

  update(
    documentRef: DocumentReference,
    field: string | FieldPath,
    value: any,
    ...fieldsOrPrecondition: any[]
  ): Promise<WriteResult>;

  delete(
    documentRef: DocumentReference,
    precondition?: Precondition
  ): Promise<WriteResult>;

  onWriteResult(
    callback: (documentRef: DocumentReference, result: WriteResult) => void
  ): void;

  onWriteError(
    shouldRetryCallback: (error: BulkWriterError) => boolean
  ): void;

  flush(): Promise<void>;
  close(): Promise<void>;
}
```

### 9. FieldValue（Admin — 静的メソッド）

```typescript
class FieldValue {
  static serverTimestamp(): FieldValue;
  static delete(): FieldValue;
  static increment(n: number): FieldValue;
  static arrayUnion(...elements: any[]): FieldValue;
  static arrayRemove(...elements: any[]): FieldValue;
  isEqual(other: FieldValue): boolean;
}
```

### 10. スナップショット型（Admin）

**`DocumentSnapshot`（Admin）:**

```typescript
class DocumentSnapshot<
  AppModelType = DocumentData,
  DbModelType extends DocumentData = DocumentData
> {
  readonly exists: boolean;
  readonly ref: DocumentReference<AppModelType, DbModelType>;
  readonly id: string;
  readonly createTime?: Timestamp;
  readonly updateTime?: Timestamp;
  readonly readTime: Timestamp;
  data(): AppModelType | undefined;
  get(fieldPath: string | FieldPath): any;
  isEqual(other: DocumentSnapshot<AppModelType, DbModelType>): boolean;
}
```

**`QueryDocumentSnapshot`（Admin）:**

```typescript
class QueryDocumentSnapshot<
  AppModelType = DocumentData,
  DbModelType extends DocumentData = DocumentData
> extends DocumentSnapshot<AppModelType, DbModelType> {
  readonly createTime: Timestamp;
  readonly updateTime: Timestamp;
  data(): AppModelType;
}
```

**`QuerySnapshot`（Admin）:**

```typescript
class QuerySnapshot<
  AppModelType = DocumentData,
  DbModelType extends DocumentData = DocumentData
> {
  readonly query: Query<AppModelType, DbModelType>;
  readonly docs: Array<QueryDocumentSnapshot<AppModelType, DbModelType>>;
  readonly size: number;
  readonly empty: boolean;
  readonly readTime: Timestamp;
  docChanges(): DocumentChange<AppModelType, DbModelType>[];
  forEach(
    callback: (result: QueryDocumentSnapshot<AppModelType, DbModelType>) => void,
    thisArg?: any
  ): void;
  isEqual(other: QuerySnapshot<AppModelType, DbModelType>): boolean;
}
```

**`WriteResult`（Admin専用）:**

```typescript
class WriteResult {
  readonly writeTime: Timestamp;
  isEqual(other: WriteResult): boolean;
}
```

### 11. Admin専用の追加型

```typescript
interface Precondition {
  readonly lastUpdateTime?: Timestamp;
  readonly exists?: boolean;
}

interface ReadOptions {
  readonly fieldMask?: (string | FieldPath)[];
}

interface BulkWriterOptions {
  readonly throttling?: boolean | {
    initialOpsPerSecond?: number;
    maxOpsPerSecond?: number;
  };
}

class CollectionGroup<
  AppModelType = DocumentData,
  DbModelType extends DocumentData = DocumentData
> extends Query<AppModelType, DbModelType> {
  getPartitions(
    desiredPartitionCount: number
  ): AsyncIterable<QueryPartition<AppModelType, DbModelType>>;
  withConverter<NewAppModelType, NewDbModelType extends DocumentData>(
    converter: FirestoreDataConverter<NewAppModelType, NewDbModelType>
  ): CollectionGroup<NewAppModelType, NewDbModelType>;
  withConverter(converter: null): CollectionGroup;
}

class BulkWriterError extends Error {
  readonly code: GrpcStatus;
  readonly message: string;
  readonly documentRef: DocumentReference;
  readonly operationType: 'create' | 'set' | 'update' | 'delete';
  readonly failedAttempts: number;
}
```

---

## Web SDK vs Admin SDK 主要な差異

| 機能 | Web SDK (modular) | Admin SDK |
|---|---|---|
| APIスタイル | トップレベル関数（`getDoc(ref)`） | オブジェクトメソッド（`ref.get()`） |
| `create()` | なし | あり |
| `Precondition` | なし | あり（`lastUpdateTime`, `exists`） |
| `offset()` | なし | あり |
| `select()` フィールド射影 | なし | あり |
| `stream()` | なし | あり（Node.js streams） |
| `BulkWriter` | なし | あり |
| `recursiveDelete()` | なし | あり |
| `listCollections()` / `listDocuments()` | なし | あり |
| `FieldValue.delete()` | `deleteField()`（関数） | `FieldValue.delete()`（静的メソッド） |
| オフライン永続化 | IndexedDB | なし（サーバーサイド） |
| `Filter` クラス | `and()` / `or()` 関数 | `Filter.where()` / `Filter.and()` / `Filter.or()` 静的メソッド |
| `WriteResult` | なし（`Promise<void>`） | あり（`Promise<WriteResult>`） |
| `readTime` / `createTime` / `updateTime` | なし（`SnapshotMetadata`） | あり（Timestampプロパティ） |
