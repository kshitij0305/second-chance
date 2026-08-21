/**
 * The shape of the Razorpay webhook payloads we consume.
 *
 * These are hand-written from observed payloads rather than imported from the
 * SDK, because the SDK types cover API responses, not webhook bodies. Anything
 * marked optional is a field that may legitimately be absent — UPI failures in
 * particular carry a different subset than card failures do.
 */

export interface RazorpayPaymentEntity {
  /** Razorpay calls this `id`. Our own tables call it `payment_id`. */
  id: string;
  amount: number;
  currency: string;
  status: string;
  order_id?: string | null;
  method?: string | null;
  email?: string | null;
  contact?: string | null;
  error_code?: string | null;
  error_description?: string | null;
  error_source?: string | null;
  error_step?: string | null;
  error_reason?: string | null;
  description?: string | null;
  /**
   * Notes set when creating a payment link propagate onto the payment that
   * settles it. That is how a recovery is attributed back to the failure that
   * caused it, without depending on the payment_link.paid subscription.
   */
  notes?: Record<string, string> | null;
}

export interface RazorpayPaymentLinkEntity {
  id: string;
  status: string;
  amount: number;
}

export interface RazorpayWebhookBody {
  event: string;
  payload: {
    payment?: { entity: RazorpayPaymentEntity };
    payment_link?: { entity: RazorpayPaymentLinkEntity };
  };
}
