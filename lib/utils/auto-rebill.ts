import { createAdminClient } from '@/lib/supabase/admin';
import { chargePaymentMethod } from '@/lib/stripe/client';

/**
 * Checks if auto-rebill is needed for a user and triggers it.
 * Fire-and-forget — failures are logged but never block the caller.
 */
export async function triggerAutoRebillIfNeeded(userId: string): Promise<void> {
  const adminClient = createAdminClient();

  // Check if rebill is needed via the database function
  const { data: needsRebill, error: checkError } = await adminClient.rpc(
    'check_wallet_needs_rebill',
    { p_user_id: userId }
  );

  if (checkError) {
    console.error('Auto-rebill check failed:', checkError.message);
    return;
  }

  if (!needsRebill) return;

  // Get user profile for Stripe details
  const { data: profile, error: profileError } = await adminClient
    .from('user_profiles')
    .select('stripe_customer_id, wallet_payment_method_id, wallet_auto_rebill_amount')
    .eq('id', userId)
    .single();

  if (profileError || !profile) {
    console.error('Auto-rebill: failed to load profile:', profileError?.message);
    return;
  }

  if (!profile.stripe_customer_id || !profile.wallet_payment_method_id) {
    console.log('Auto-rebill: missing Stripe customer or payment method for user', userId);
    return;
  }

  const amount = profile.wallet_auto_rebill_amount || 25;

  try {
    await chargePaymentMethod({
      customerId: profile.stripe_customer_id,
      paymentMethodId: profile.wallet_payment_method_id,
      amount,
      description: `Auto-rebill: $${amount.toFixed(2)}`,
    });
    console.log(`Auto-rebill: charged $${amount.toFixed(2)} for user ${userId}`);
  } catch (chargeError) {
    console.error('Auto-rebill charge failed:', chargeError);
  }
}
