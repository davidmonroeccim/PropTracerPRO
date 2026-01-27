'use client';

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Copy, Check, Phone, Mail, MapPin, User } from 'lucide-react';
import { PushToCrmButton } from '@/components/trace/PushToCrmButton';
import type { TraceResult } from '@/types';

interface TraceResultCardProps {
  result: TraceResult | null;
  isCached: boolean;
  charge: number;
  address: string;
  traceId?: string;
}

export function TraceResultCard({ result, isCached, charge, address, traceId }: TraceResultCardProps) {
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
          <p className="text-gray-500">
            We couldn&apos;t find owner information for this property. This may be due to:
          </p>
          <ul className="mt-2 list-disc list-inside text-sm text-gray-500">
            <li>Property owned by an entity (LLC, Trust, etc.)</li>
            <li>Recently transferred property</li>
            <li>Address format mismatch</li>
          </ul>
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
          </div>
          <div className="text-right">
            <p className="text-sm text-gray-500">Charge</p>
            <p className="text-lg font-semibold">
              {charge > 0 ? formatCurrency(charge) : 'Free (cached)'}
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Owner Name */}
        {(result.owner_name || result.owner_name_2) && (
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-gray-500 mb-2">
              <User className="h-4 w-4" />
              Owner Name
            </div>
            <div className="space-y-1">
              {result.owner_name && (
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
              )}
              {result.owner_name_2 && (
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
              )}
            </div>
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
