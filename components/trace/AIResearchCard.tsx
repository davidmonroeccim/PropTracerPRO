'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Search, User, Building2, Skull, Users, Home, Link, AlertTriangle } from 'lucide-react';
import type { AIResearchResult } from '@/types';

interface AIResearchCardProps {
  research: AIResearchResult;
  charge: number;
}

export function AIResearchCard({ research, charge }: AIResearchCardProps) {
  const ownerTypeLabel: Record<string, string> = {
    individual: 'Individual',
    business: 'Business / LLC',
    trust: 'Trust',
    unknown: 'Unknown',
  };

  const propertyTypeLabel: Record<string, string> = {
    residential: 'Residential',
    commercial: 'Commercial',
    vacant_land: 'Vacant Land',
    multi_family: 'Multi-Family',
    unknown: 'Unknown',
  };

  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);

  const hasOwner = !!research.owner_name;
  const isBusiness = research.owner_type === 'business' || research.owner_type === 'trust';

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Search className="h-4 w-4" />
            AI Research Results
          </CardTitle>
          <div className="text-right">
            <p className="text-sm text-gray-500">Research Charge</p>
            <p className="text-sm font-semibold">
              {charge > 0 ? formatCurrency(charge) : 'Free (cached)'}
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Owner Info */}
        {hasOwner && (
          <div className="bg-gray-50 rounded-lg p-3">
            <div className="flex items-center gap-2 text-sm font-medium text-gray-500 mb-2">
              <User className="h-4 w-4" />
              Property Owner
            </div>
            <p className="text-gray-900 font-semibold text-lg">{research.owner_name}</p>
            <Badge variant="outline" className="mt-1 text-xs">
              {ownerTypeLabel[research.owner_type] || 'Unknown'}
            </Badge>
          </div>
        )}

        {/* Business Entity - expanded section */}
        {research.business_name && (
          <div className={`rounded-lg p-3 ${isBusiness ? 'bg-amber-50 border border-amber-200' : 'bg-gray-50'}`}>
            <div className="flex items-center gap-2 text-sm font-medium text-gray-500 mb-2">
              <Building2 className="h-4 w-4" />
              {research.owner_type === 'trust' ? 'Trust Entity' : 'Business Entity'}
            </div>
            <p className="text-gray-900 font-semibold">{research.business_name}</p>

            {research.individual_behind_business && (
              <div className="mt-2 pl-3 border-l-2 border-amber-300">
                <p className="text-xs text-gray-500 uppercase tracking-wide">Principal / Registered Agent</p>
                <p className="text-gray-900 font-medium">{research.individual_behind_business}</p>
              </div>
            )}

            {isBusiness && !research.individual_behind_business && (
              <div className="mt-2 flex items-center gap-1.5 text-amber-700">
                <AlertTriangle className="h-3.5 w-3.5" />
                <p className="text-xs">No individual identified behind this entity</p>
              </div>
            )}
          </div>
        )}

        {/* Deceased Status */}
        {research.is_deceased !== null && (
          <div className={`rounded-lg p-3 ${research.is_deceased ? 'bg-red-50 border border-red-200' : 'bg-green-50 border border-green-200'}`}>
            <div className="flex items-center gap-2 text-sm font-medium text-gray-500 mb-2">
              <Skull className="h-4 w-4" />
              Deceased Status
            </div>
            {research.is_deceased ? (
              <div>
                <Badge className="bg-red-100 text-red-700">Deceased</Badge>
                {research.deceased_details && (
                  <p className="text-sm text-red-800 mt-2">{research.deceased_details}</p>
                )}
              </div>
            ) : (
              <Badge className="bg-green-100 text-green-700">Not Deceased</Badge>
            )}
          </div>
        )}

        {/* Decision Makers */}
        {research.decision_makers.length > 0 && (
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-gray-500 mb-2">
              <Users className="h-4 w-4" />
              Decision Makers
            </div>
            <div className="space-y-1">
              {research.decision_makers.map((name, i) => (
                <div key={`dm-${i}`} className="flex items-center gap-2 bg-blue-50 rounded px-3 py-1.5">
                  <User className="h-3.5 w-3.5 text-blue-600" />
                  <span className="text-sm font-medium text-gray-900">{name}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Relatives */}
        {research.relatives.length > 0 && (
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-gray-500 mb-2">
              <Users className="h-4 w-4" />
              Relatives / Associated People
            </div>
            <div className="flex flex-wrap gap-1.5">
              {research.relatives.map((name, i) => (
                <Badge key={`rel-${i}`} variant="outline" className="text-xs">{name}</Badge>
              ))}
            </div>
          </div>
        )}

        {/* Property Type */}
        {research.property_type !== 'unknown' && (
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-gray-500 mb-2">
              <Home className="h-4 w-4" />
              Property Type
            </div>
            <Badge variant="outline">{propertyTypeLabel[research.property_type] || research.property_type}</Badge>
          </div>
        )}

        {/* Sources */}
        {research.sources.length > 0 && (
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-gray-500 mb-2">
              <Link className="h-4 w-4" />
              Sources ({research.sources.length})
            </div>
            <div className="space-y-1">
              {research.sources.map((url, i) => {
                let displayUrl = url;
                try {
                  const parsed = new URL(url);
                  displayUrl = parsed.hostname + (parsed.pathname !== '/' ? parsed.pathname : '');
                } catch {
                  // keep original
                }
                return (
                  <a
                    key={i}
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-xs text-blue-600 hover:text-blue-800 hover:underline truncate"
                  >
                    {displayUrl}
                  </a>
                );
              })}
            </div>
          </div>
        )}

        {/* Confidence */}
        {research.confidence > 0 && (
          <div className="pt-3 border-t">
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-500">AI Confidence:</span>
              <div className="flex-1 bg-gray-200 rounded-full h-2.5">
                <div
                  className={`h-2.5 rounded-full ${
                    research.confidence >= 70
                      ? 'bg-green-500'
                      : research.confidence >= 40
                      ? 'bg-yellow-500'
                      : 'bg-red-500'
                  }`}
                  style={{ width: `${research.confidence}%` }}
                />
              </div>
              <span className="text-sm font-semibold">{research.confidence}%</span>
            </div>
            <p className="text-xs text-gray-400 mt-1">
              {research.confidence >= 70
                ? 'High confidence — likely accurate'
                : research.confidence >= 40
                ? 'Moderate confidence — verify before use'
                : 'Low confidence — treat as unverified'}
            </p>
          </div>
        )}

        {/* No results */}
        {!hasOwner && research.confidence === 0 && (
          <div className="bg-gray-50 rounded-lg p-4 text-center">
            <p className="text-sm text-gray-500">
              No owner information found for this property. You can still enter the owner name manually.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
