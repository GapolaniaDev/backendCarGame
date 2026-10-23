// Store receipts as the Unity client sends them (plan T-24, HT-78).
//
// `BackendCarGamePurchaseFulfiller` posts Unity IAP's `Order.Info.Receipt`
// as `receiptData`: the unified receipt
//   {"Store":"AppleAppStore"|"GooglePlay","TransactionID":"…","Payload":"…"}
// Apple's `Payload` is the base64 App Store receipt. Google's is a JSON
// string `{"json":"<purchase JSON>","signature":"…",…}` — the
// `UnityPayload` mode of the client's receipt installer — and the
// `PurchaseJson` mode sends the inner purchase JSON itself:
//   {"orderId","packageName","productId","purchaseTime","purchaseState","purchaseToken",…}
// Every shape is accepted, already unwrapped or not; a bare Google
// purchase token is still accepted for older callers.

function parseObject(text: string): Record<string, unknown> | null {
  const t = text.trim();
  if (!t.startsWith('{')) return null;
  try {
    const v: unknown = JSON.parse(t);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

export interface UnifiedReceipt {
  /** `Store` of the unified receipt, when the receipt was one. */
  store?: string;
  /** `TransactionID` of the unified receipt, when present. */
  transactionId?: string;
  /** The store payload (the whole input when it was not a unified receipt). */
  payload: string;
}

/** Unwraps Unity's unified receipt; any other input is its own payload. */
export function unwrapUnityReceipt(receiptData: string): UnifiedReceipt {
  const root = parseObject(receiptData);
  const payload = root === null ? undefined : root['Payload'];
  if (root === null || typeof payload !== 'string') return { payload: receiptData };
  const out: UnifiedReceipt = { payload };
  const store = str(root['Store']);
  const tx = str(root['TransactionID']);
  if (store !== undefined) out.store = store;
  if (tx !== undefined) out.transactionId = tx;
  return out;
}

/** The base64 App Store receipt inside `receiptData`, or `null` when there is none. */
export function appleReceiptPayload(receiptData: string): string | null {
  const p = unwrapUnityReceipt(receiptData).payload.trim();
  // The App Store receipt is a base64 PKCS#7 blob; anything else (JSON,
  // free text) is not one and never reaches Apple.
  if (p.length < 16 || !/^[A-Za-z0-9+/=\r\n]+$/.test(p)) return null;
  return p.replace(/[\r\n]/g, '');
}

export interface GooglePurchase {
  purchaseToken: string;
  orderId?: string;
  productId?: string;
  packageName?: string;
  purchaseState?: number;
  purchaseTime?: number;
}

/** The Google Play purchase inside `receiptData` (all formats above), or `null`. */
export function googlePurchase(receiptData: string): GooglePurchase | null {
  let obj = parseObject(unwrapUnityReceipt(receiptData).payload);
  if (obj === null) {
    const token = unwrapUnityReceipt(receiptData).payload.trim();
    // A bare purchase token (no JSON): opaque, URL-safe characters only.
    return /^[A-Za-z0-9._\-:]{16,}$/.test(token) ? { purchaseToken: token } : null;
  }
  // UnityPayload: {"json":"<purchase JSON>","signature":…}
  const inner = obj['json'];
  if (typeof inner === 'string') obj = parseObject(inner);
  if (obj === null) return null;
  const token = str(obj['purchaseToken']) ?? str(obj['token']);
  if (token === undefined) return null;
  const out: GooglePurchase = { purchaseToken: token };
  const orderId = str(obj['orderId']);
  const productId = str(obj['productId']);
  const packageName = str(obj['packageName']);
  if (orderId !== undefined) out.orderId = orderId;
  if (productId !== undefined) out.productId = productId;
  if (packageName !== undefined) out.packageName = packageName;
  if (typeof obj['purchaseState'] === 'number') out.purchaseState = obj['purchaseState'];
  if (typeof obj['purchaseTime'] === 'number') out.purchaseTime = obj['purchaseTime'];
  return out;
}
