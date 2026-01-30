import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { researchPropertyBatch } from '@/lib/ai-research/client';
import { AI_RESEARCH } from '@/lib/constants';

export const maxDuration = 300; // 5 minute timeout for Vercel Pro

interface BulkResearchRecord {
  address: string;
  city: string;
  state: string;
  zip: string;
  owner_name?: string;
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const body = await request.json();
    const records: BulkResearchRecord[] = body.records;
    const jobId: string | undefined = body.job_id;

    if (!records || !Array.isArray(records) || records.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No records provided' },
        { status: 400 }
      );
    }

    if (records.length > AI_RESEARCH.BULK_CHUNK_SIZE) {
      return NextResponse.json(
        { success: false, error: `Maximum ${AI_RESEARCH.BULK_CHUNK_SIZE} records per request` },
        { status: 400 }
      );
    }

    // Check wallet balance for worst-case (all records found)
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('wallet_balance')
      .eq('id', user.id)
      .single();

    if (!profile) {
      return NextResponse.json(
        { success: false, error: 'User profile not found' },
        { status: 400 }
      );
    }

    const maxCost = records.length * AI_RESEARCH.CHARGE_PER_RECORD;
    if (profile.wallet_balance < AI_RESEARCH.CHARGE_PER_RECORD) {
      return NextResponse.json(
        { success: false, error: 'Insufficient wallet balance for AI research.' },
        { status: 402 }
      );
    }

    const adminClient = createAdminClient();

    // Update research job progress if job_id provided
    if (jobId) {
      await adminClient
        .from('research_jobs')
        .update({ status: 'processing' })
        .eq('id', jobId)
        .eq('user_id', user.id);
    }

    // Run batch research
    const results = await researchPropertyBatch(records);

    // Charge for each record where owner was found
    let totalCharge = 0;
    const enrichedRecords = records.map((record, i) => {
      const research = results[i];
      let charge = 0;

      if (research.owner_name) {
        charge = AI_RESEARCH.CHARGE_PER_RECORD;
        totalCharge += charge;
      }

      return {
        ...record,
        ai_research: research,
        ai_research_charge: charge,
        // Use discovered owner name if record didn't have one
        owner_name: record.owner_name || research.individual_behind_business || research.owner_name || undefined,
      };
    });

    // Deduct total charge from wallet
    if (totalCharge > 0) {
      const { data: deducted } = await adminClient.rpc('deduct_wallet_balance', {
        p_user_id: user.id,
        p_amount: totalCharge,
        p_description: `AI research: ${enrichedRecords.filter((r) => r.ai_research.owner_name).length} owners found`,
      });

      if (!deducted) {
        return NextResponse.json(
          { success: false, error: 'Failed to deduct wallet balance' },
          { status: 402 }
        );
      }
    }

    // Update research job if tracking
    const recordsFound = enrichedRecords.filter((r) => r.ai_research.owner_name).length;
    if (jobId) {
      await adminClient
        .from('research_jobs')
        .update({
          records_completed: records.length,
          records_found: recordsFound,
        })
        .eq('id', jobId)
        .eq('user_id', user.id);
    }

    return NextResponse.json({
      success: true,
      records: enrichedRecords,
      total_charge: totalCharge,
      records_found: recordsFound,
      records_processed: records.length,
    });
  } catch (error) {
    console.error('Bulk research error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { success: false, error: `Bulk research failed: ${message}` },
      { status: 500 }
    );
  }
}
