import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import Stripe from 'stripe';
import { stripe } from '@/lib/stripe/client';
import { createAdminClient } from '@/lib/supabase/admin';

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;

export async function POST(request: Request) {
  const body = await request.text();
  const headersList = await headers();
  const signature = headersList.get('stripe-signature')!;

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (error) {
    console.error('Webhook signature verification failed:', error);
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  const adminClient = createAdminClient();

  try {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = subscription.customer as string;

        // Determine tier from price
        const priceId = subscription.items.data[0]?.price.id;
        let tier = 'wallet';

        if (priceId === process.env.STRIPE_PRICE_STARTER) {
          tier = 'starter';
        } else if (priceId === process.env.STRIPE_PRICE_PRO) {
          tier = 'pro';
        }

        // Update user profile
        await adminClient
          .from('user_profiles')
          .update({
            subscription_tier: tier,
            stripe_subscription_id: subscription.id,
          })
          .eq('stripe_customer_id', customerId);

        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = subscription.customer as string;

        // Downgrade to wallet tier
        await adminClient
          .from('user_profiles')
          .update({
            subscription_tier: 'wallet',
            stripe_subscription_id: null,
          })
          .eq('stripe_customer_id', customerId);

        break;
      }

      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;

        // Handle wallet top-up
        if (session.metadata?.type === 'wallet_topup') {
          const amount = parseFloat(session.metadata.amount || '0');
          const customerId = session.customer as string;

          // Get user by customer ID
          const { data: profile } = await adminClient
            .from('user_profiles')
            .select('id')
            .eq('stripe_customer_id', customerId)
            .single();

          if (profile) {
            // Credit wallet
            await adminClient.rpc('credit_wallet_balance', {
              p_user_id: profile.id,
              p_amount: amount,
              p_stripe_payment_intent_id: session.payment_intent as string,
              p_description: `Wallet top-up: $${amount.toFixed(2)}`,
            });
          }
        }

        break;
      }

      case 'invoice.paid': {
        const invoice = event.data.object as Stripe.Invoice;

        // Log successful payment
        console.log('Invoice paid:', invoice.id, 'Amount:', invoice.amount_paid);

        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = invoice.customer as string;

        // Log failed payment - could send email notification
        console.error('Invoice payment failed:', invoice.id, 'Customer:', customerId);

        // TODO: Send email notification about failed payment

        break;
      }

      case 'payment_intent.succeeded': {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;

        // Handle auto-rebill success
        if (paymentIntent.metadata?.type === 'wallet_auto_rebill') {
          const customerId = paymentIntent.customer as string;
          const amount = paymentIntent.amount / 100; // convert from cents

          // Get user by customer ID
          const { data: profile } = await adminClient
            .from('user_profiles')
            .select('id')
            .eq('stripe_customer_id', customerId)
            .single();

          if (profile) {
            // Credit wallet
            await adminClient.rpc('credit_wallet_balance', {
              p_user_id: profile.id,
              p_amount: amount,
              p_stripe_payment_intent_id: paymentIntent.id,
              p_description: `Auto-rebill: $${amount.toFixed(2)}`,
            });

            // Update last rebill timestamp
            await adminClient
              .from('user_profiles')
              .update({ wallet_last_rebill_at: new Date().toISOString() })
              .eq('id', profile.id);
          }
        }

        break;
      }

      default:
        console.log('Unhandled webhook event:', event.type);
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error('Webhook handler error:', error);
    return NextResponse.json({ error: 'Webhook handler failed' }, { status: 500 });
  }
}
