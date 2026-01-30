'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Search, User, Building2, Skull, Users, Home } from 'lucide-react';
import type { AIResearchResult } from '@/types';

interface AIResearchCardProps {
  research: AIResearchResult;
  charge: number;
}

export function AIResearchCard({ research, charge }: AIResearchCardProps) {
  const ownerTypeLabel = {
    individual: 'Individual',
    business: 'Business/LLC',
    trust: 'Trust',
    unknown: 'Unknown',
  };

  const propertyTypeLabel = {
    residential: 'Residential',
    commercial: 'Commercial',
    vacant_land: 'Vacant Land',
    multi_family: 'Multi-Family',
    unknown: 'Unknown',
  };

  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);

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
      <CardContent className="space-y-4">
        {/* Owner Info */}
        {research.owner_name && (
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-gray-500 mb-1">
              <User className="h-4 w-4" />
              Owner
            </div>
            <div className="flex items-center gap-2">
              <span className="text-gray-900 font-medium">{research.owner_name}</span>
              <Badge variant="outline" className="text-xs">
                {ownerTypeLabel[research.owner_type]}
              </Badge>
            </div>
          </div>
        )}

        {/* Business Entity */}
        {research.business_name && (
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-gray-500 mb-1">
              <Building2 className="h-4 w-4" />
              Entity
            </div>
            <p className="text-gray-900">{research.business_name}</p>
            {research.individual_behind_business && (
              <p className="text-sm text-gray-600 mt-1">
                Principal: {research.individual_behind_business}
              </p>
            )}
          </div>
        )}

        {/* Deceased Status */}
        {research.is_deceased !== null && (
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-gray-500 mb-1">
              <Skull className="h-4 w-4" />
              Deceased Status
            </div>
            {research.is_deceased ? (
              <div>
                <Badge className="bg-red-100 text-red-700">Deceased</Badge>
                {research.deceased_details && (
                  <p className="text-sm text-gray-600 mt-1">{research.deceased_details}</p>
                )}
              </div>
            ) : (
              <Badge className="bg-green-100 text-green-700">Not Deceased</Badge>
            )}
          </div>
        )}

        {/* Relatives / Decision Makers */}
        {(research.relatives.length > 0 || research.decision_makers.length > 0) && (
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-gray-500 mb-1">
              <Users className="h-4 w-4" />
              {research.decision_makers.length > 0 ? 'Decision Makers / Relatives' : 'Relatives'}
            </div>
            <div className="flex flex-wrap gap-1">
              {research.decision_makers.map((name, i) => (
                <Badge key={`dm-${i}`} className="bg-blue-100 text-blue-700">{name}</Badge>
              ))}
              {research.relatives.map((name, i) => (
                <Badge key={`rel-${i}`} variant="outline">{name}</Badge>
              ))}
            </div>
          </div>
        )}

        {/* Property Type */}
        {research.property_type !== 'unknown' && (
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-gray-500 mb-1">
              <Home className="h-4 w-4" />
              Property Type
            </div>
            <Badge variant="outline">{propertyTypeLabel[research.property_type]}</Badge>
          </div>
        )}

        {/* Confidence */}
        {research.confidence > 0 && (
          <div className="flex items-center gap-2 pt-3 border-t">
            <span className="text-sm text-gray-500">AI Confidence:</span>
            <div className="flex-1 bg-gray-200 rounded-full h-2">
              <div
                className={`h-2 rounded-full ${
                  research.confidence >= 70
                    ? 'bg-green-500'
                    : research.confidence >= 40
                    ? 'bg-yellow-500'
                    : 'bg-red-500'
                }`}
                style={{ width: `${research.confidence}%` }}
              />
            </div>
            <span className="text-sm font-medium">{research.confidence}%</span>
          </div>
        )}

        {/* No results */}
        {!research.owner_name && research.confidence === 0 && (
          <p className="text-sm text-gray-500">
            No owner information found for this property. You can still enter the owner name manually.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
