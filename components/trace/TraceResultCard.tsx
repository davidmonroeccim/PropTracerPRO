'use client';

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Copy, Check, Phone, Mail, MapPin, User, Building2 } from 'lucide-react';
import { PushToCrmButton } from '@/components/trace/PushToCrmButton';
import { foundByLabel } from '@/lib/trace/historyDisplay';
import type { TraceResult } from '@/types';

interface TraceResultCardProps {
  result: TraceResult | null;
  isCached: boolean;
  charge: number;
  address: string;
  traceId?: string;
  /** The KEY that found the owner (spec 7.1): address, parcel_id or company_name. */
  foundBy?: string | null;
  /** Why nothing came back, in the customer's words (spec 7.1). Shown instead of any guess. */
  skipReason?: string | null;
}

export function TraceResultCard({ result, isCached, charge, address, traceId, foundBy, skipReason }: TraceResultCardProps) {
  const [copiedItem, setCopiedItem] = useState<string | null>(null);

  const copyToClipboard = async (text: string, id: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedItem(id);
    setTimeout(() => setCopiedItem(null), 2000);
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(amount);
  };

  const getPhoneTypeBadge = (type: string) => {
    switch (type) {
      case 'mobile':
        return <Badge className="bg-green-100 text-green-700">Mobile</Badge>;
      case 'landline':
        return <Badge className="bg-blue-100 text-blue-700">Landline</Badge>;
      case 'voip':
        return <Badge className="bg-purple-100 text-purple-700">VOIP</Badge>;
      default:
        return <Badge variant="outline">Unknown</Badge>;
    }
  };

  if (!result) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No Results Found</CardTitle>
          <CardDescription>{address}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-gray-600">
            {skipReason ?? 'We could not find owner information for this property.'}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              Trace Results
              {isCached && (
                <Badge className="bg-blue-100 text-blue-700">Cached</Badge>
              )}
            </CardTitle>
            <CardDescription>{address}</CardDescription>
            {foundByLabel(foundBy) && (
              <p className="text-sm text-gray-500 mt-1">Found by: {foundByLabel(foundBy)}</p>
            )}
          </div>
          <div className="text-right">
            <p className="text-sm text-gray-500">Charge</p>
            <p className="text-lg font-semibold">
              {charge > 0 ? formatCurrency(charge) : isCached ? 'Free (cached)' : 'Free'}
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/*
          TWO NAMES, TWO MEANINGS. They used to sit under one unlabelled "Owner
          Name" heading, which made a company and a person look like two guesses
          at the same thing.

            owner_name    the CONTACT PERSON we resolved behind the owner. Null
                          for an entity with no named principal, because a
                          company name is never a contact person.
            owner_name_2  the OWNER OF RECORD as the county roll has it, which
                          is what a Full Property Trace bought.
        */}
        {(result.owner_name || result.owner_name_2) && (
          <div className="space-y-3">
            {result.owner_name && (
              <div>
                <div className="flex items-center gap-2 text-sm font-medium text-gray-500 mb-2">
                  <User className="h-4 w-4" />
                  Contact Person
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-900">{result.owner_name}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => copyToClipboard(result.owner_name!, 'owner1')}
                  >
                    {copiedItem === 'owner1' ? (
                      <Check className="h-4 w-4 text-green-600" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>
            )}
            {result.owner_name_2 && (
              <div>
                <div className="flex items-center gap-2 text-sm font-medium text-gray-500 mb-2">
                  <Building2 className="h-4 w-4" />
                  Owner of Record
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-900">{result.owner_name_2}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => copyToClipboard(result.owner_name_2!, 'owner2')}
                  >
                    {copiedItem === 'owner2' ? (
                      <Check className="h-4 w-4 text-green-600" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </Button>
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  The name on the county roll for this parcel.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Phone Numbers */}
        {result.phones && result.phones.length > 0 && (
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-gray-500 mb-2">
              <Phone className="h-4 w-4" />
              Phone Numbers ({result.phones.length})
            </div>
            <div className="space-y-2">
              {result.phones.map((phone, index) => (
                <div
                  key={index}
                  className="flex items-center justify-between bg-gray-50 rounded-md p-2"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-gray-900">{phone.number}</span>
                    {getPhoneTypeBadge(phone.type)}
                    {phone.is_dnc && (
                      <Badge variant="destructive">DNC</Badge>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => copyToClipboard(phone.number, `phone-${index}`)}
                  >
                    {copiedItem === `phone-${index}` ? (
                      <Check className="h-4 w-4 text-green-600" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Email Addresses */}
        {result.emails && result.emails.length > 0 && (
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-gray-500 mb-2">
              <Mail className="h-4 w-4" />
              Email Addresses ({result.emails.length})
            </div>
            <div className="space-y-2">
              {result.emails.map((email, index) => (
                <div
                  key={index}
                  className="flex items-center justify-between bg-gray-50 rounded-md p-2"
                >
                  <span className="text-gray-900">{email}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => copyToClipboard(email, `email-${index}`)}
                  >
                    {copiedItem === `email-${index}` ? (
                      <Check className="h-4 w-4 text-green-600" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Mailing Address */}
        {result.mailing_address && (
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-gray-500 mb-2">
              <MapPin className="h-4 w-4" />
              Mailing Address
            </div>
            <div className="flex items-center justify-between bg-gray-50 rounded-md p-2">
              <span className="text-gray-900">
                {result.mailing_address}
                {result.mailing_city && `, ${result.mailing_city}`}
                {result.mailing_state && `, ${result.mailing_state}`}
                {result.mailing_zip && ` ${result.mailing_zip}`}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  const full = [
                    result.mailing_address,
                    result.mailing_city,
                    result.mailing_state,
                    result.mailing_zip,
                  ]
                    .filter(Boolean)
                    .join(', ');
                  copyToClipboard(full, 'mailing');
                }}
              >
                {copiedItem === 'mailing' ? (
                  <Check className="h-4 w-4 text-green-600" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>
        )}

        {/* Match Confidence */}
        {result.match_confidence > 0 && (
          <div className="flex items-center gap-2 pt-4 border-t">
            <span className="text-sm text-gray-500">Match Confidence:</span>
            <div className="flex-1 bg-gray-200 rounded-full h-2">
              <div
                className={`h-2 rounded-full ${
                  result.match_confidence >= 80
                    ? 'bg-green-500'
                    : result.match_confidence >= 50
                    ? 'bg-yellow-500'
                    : 'bg-red-500'
                }`}
                style={{ width: `${result.match_confidence}%` }}
              />
            </div>
            <span className="text-sm font-medium">{result.match_confidence}%</span>
          </div>
        )}

        {/* Push to CRM */}
        {traceId && (
          <div className="pt-4 border-t">
            <PushToCrmButton traceId={traceId} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
