import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { User, CreditCard, Key, Link as LinkIcon } from 'lucide-react';

const settingsLinks = [
  {
    name: 'Profile',
    description: 'Manage your account details and company information',
    href: '/settings/profile',
    icon: User,
  },
  {
    name: 'Billing',
    description: 'Manage your subscription and wallet balance',
    href: '/settings/billing',
    icon: CreditCard,
  },
  {
    name: 'API Keys',
    description: 'Generate and manage your API keys',
    href: '/settings/api-keys',
    icon: Key,
  },
  {
    name: 'Integrations',
    description: 'Connect with HighLevel and other tools',
    href: '/settings/integrations',
    icon: LinkIcon,
  },
];

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
        <p className="text-gray-500">Manage your account and preferences</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {settingsLinks.map((item) => (
          <Link key={item.name} href={item.href}>
            <Card className="hover:bg-gray-50 transition-colors cursor-pointer h-full">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-gray-100 rounded-lg">
                    <item.icon className="h-5 w-5 text-gray-600" />
                  </div>
                  <div>
                    <CardTitle className="text-base">{item.name}</CardTitle>
                    <CardDescription>{item.description}</CardDescription>
                  </div>
                </div>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
