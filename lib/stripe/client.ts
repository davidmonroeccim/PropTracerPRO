import Stripe from 'stripe';

// Create Stripe instance lazily to avoid build-time errors
let stripeInstance: Stripe | null = null;

export function getStripe(): Stripe {
  if (!stripeInstance) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY is not set');
    }
    stripeInstance = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2025-12-15.clover',
      typescript: true,
    });
  }
  return stripeInstance;
}

// For backwards compatibility
export const stripe = {
  get customers() { return getStripe().customers; },
  get checkout() { return getStripe().checkout; },
  get subscriptions() { return getStripe().subscriptions; },
  get subscriptionItems() { return getStripe().subscriptionItems; },
  get paymentIntents() { return getStripe().paymentIntents; },
  get paymentMethods() { return getStripe().paymentMethods; },
  get setupIntents() { return getStripe().setupIntents; },
  get billingPortal() { return getStripe().billingPortal; },
  get billing() { return getStripe().billing; },
  get webhooks() { return getStripe().webhooks; },
};

/**
 * Create a Stripe customer for a new user.
 */
export async function createCustomer(email: string, name?: string) {
  return stripe.customers.create({
    email,
    name,
    metadata: {
      source: 'proptracerpro',
    },
  });
}

/**
 * Create a checkout session for subscription.
 */
export async function createCheckoutSession(params: {
  customerId: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  trialDays?: number;
}) {
  return stripe.checkout.sessions.create({
    customer: params.customerId,
    mode: 'subscription',
    line_items: [
      {
        price: params.priceId,
        quantity: 1,
      },
    ],
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    subscription_data: params.trialDays
      ? { trial_period_days: params.trialDays }
      : undefined,
  });
}

/**
 * Create a checkout session for wallet top-up.
 */
export async function createWalletTopUpSession(params: {
  customerId: string;
  amount: number; // in dollars
  successUrl: string;
  cancelUrl: string;
}) {
  return stripe.checkout.sessions.create({
    customer: params.customerId,
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency: 'usd',
          unit_amount: Math.round(params.amount * 100), // convert to cents
          product_data: {
            name: 'PropTracerPRO Wallet Top-Up',
            description: `Add $${params.amount.toFixed(2)} to your wallet`,
          },
        },
        quantity: 1,
      },
    ],
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    metadata: {
      type: 'wallet_topup',
      amount: params.amount.toString(),
    },
  });
}

/**
 * Create a setup intent for saving a payment method.
 */
export async function createSetupIntent(customerId: string) {
  return stripe.setupIntents.create({
    customer: customerId,
    payment_method_types: ['card'],
  });
}

/**
 * Get customer's default payment method.
 */
export async function getDefaultPaymentMethod(customerId: string) {
  const customer = await stripe.customers.retrieve(customerId);
  if (customer.deleted) return null;

  const defaultPaymentMethodId = customer.invoice_settings?.default_payment_method;
  if (!defaultPaymentMethodId || typeof defaultPaymentMethodId !== 'string') {
    return null;
  }

  return stripe.paymentMethods.retrieve(defaultPaymentMethodId);
}

/**
 * Charge a payment method for wallet auto-rebill.
 */
export async function chargePaymentMethod(params: {
  customerId: string;
  paymentMethodId: string;
  amount: number; // in dollars
  description: string;
}) {
  return stripe.paymentIntents.create({
    amount: Math.round(params.amount * 100), // convert to cents
    currency: 'usd',
    customer: params.customerId,
    payment_method: params.paymentMethodId,
    off_session: true,
    confirm: true,
    description: params.description,
    metadata: {
      type: 'wallet_auto_rebill',
    },
  });
}

/**
 * Create a billing portal session.
 */
export async function createBillingPortalSession(
  customerId: string,
  returnUrl: string
) {
  return stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
}

/**
 * Report usage for metered billing.
 * Note: Usage records are created via billing meter events in newer Stripe API versions.
 */
export async function reportUsage(
  subscriptionItemId: string,
  quantity: number
) {
  // For newer Stripe API, usage is typically tracked via billing meters
  // This is a placeholder that should be updated based on your Stripe setup
  return stripe.billing.meterEvents.create({
    event_name: 'skip_trace_usage',
    payload: {
      stripe_customer_id: subscriptionItemId, // This would need the customer ID
      value: quantity.toString(),
    },
    timestamp: Math.floor(Date.now() / 1000),
  });
}

/**
 * Get subscription details.
 */
export async function getSubscription(subscriptionId: string) {
  return stripe.subscriptions.retrieve(subscriptionId, {
    expand: ['items.data.price'],
  });
}

/**
 * Cancel a subscription.
 */
export async function cancelSubscription(subscriptionId: string) {
  return stripe.subscriptions.cancel(subscriptionId);
}
