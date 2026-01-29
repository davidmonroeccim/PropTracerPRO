'use client';

import { useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Search,
  FileUp,
  Clock,
  Key,
  Link as LinkIcon,
  Wallet,
  Menu,
  X,
  ChevronDown,
  ChevronUp,
  CheckCircle,
  Upload,
  Download,
} from 'lucide-react';

/* ──────────────────────────── NAV ──────────────────────────── */

function Nav() {
  const [open, setOpen] = useState(false);

  return (
    <nav className="sticky top-0 z-50 bg-white/95 backdrop-blur border-b border-gray-200">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 flex items-center justify-between h-16">
        <Link href="/">
          <Image src="/logo.png" alt="PropTracerPRO" width={180} height={40} priority />
        </Link>

        {/* Desktop links */}
        <div className="hidden md:flex items-center gap-6">
          <a href="#features" className="text-sm text-gray-600 hover:text-[#1B3A5C]">Features</a>
          <a href="#pricing" className="text-sm text-gray-600 hover:text-[#1B3A5C]">Pricing</a>
          <a href="#faq" className="text-sm text-gray-600 hover:text-[#1B3A5C]">FAQ</a>
          <Link href="/login">
            <Button variant="ghost" size="sm">Sign In</Button>
          </Link>
          <Link href="/register">
            <Button size="sm" className="bg-[#E8872A] hover:bg-[#F09A45] text-white">Get Started</Button>
          </Link>
        </div>

        {/* Mobile hamburger */}
        <button className="md:hidden -m-2 p-2 text-gray-700" onClick={() => setOpen(!open)}>
          {open ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
        </button>
      </div>

      {/* Mobile menu */}
      {open && (
        <div className="md:hidden border-t border-gray-200 bg-white px-4 py-4 space-y-3">
          <a href="#features" className="block text-sm text-gray-600" onClick={() => setOpen(false)}>Features</a>
          <a href="#pricing" className="block text-sm text-gray-600" onClick={() => setOpen(false)}>Pricing</a>
          <a href="#faq" className="block text-sm text-gray-600" onClick={() => setOpen(false)}>FAQ</a>
          <div className="flex gap-3 pt-2">
            <Link href="/login" className="flex-1">
              <Button variant="outline" className="w-full" size="sm">Sign In</Button>
            </Link>
            <Link href="/register" className="flex-1">
              <Button className="w-full bg-[#E8872A] hover:bg-[#F09A45] text-white" size="sm">Get Started</Button>
            </Link>
          </div>
        </div>
      )}
    </nav>
  );
}

/* ──────────────────────────── HERO ──────────────────────────── */

function Hero() {
  return (
    <section className="bg-gradient-to-b from-white to-[#4A8CC7]/10 py-20 lg:py-28">
      <div className="mx-auto max-w-4xl px-4 sm:px-6 text-center">
        <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold text-[#1B3A5C] leading-tight">
          Skip Tracing Built for Commercial Real Estate
        </h1>
        <p className="mt-6 text-lg sm:text-xl text-gray-600 max-w-2xl mx-auto">
          Find property owner phone numbers and emails in seconds. Single lookups or bulk upload up to 10,000 records. Pay only for successful matches.
        </p>
        <div className="mt-10 flex flex-col sm:flex-row gap-4 justify-center">
          <Link href="/register">
            <Button size="lg" className="bg-[#E8872A] hover:bg-[#F09A45] text-white text-lg px-8 py-6 w-full sm:w-auto">
              Start Tracing Free
            </Button>
          </Link>
          <a href="#pricing">
            <Button size="lg" variant="outline" className="text-lg px-8 py-6 border-[#1B3A5C] text-[#1B3A5C] w-full sm:w-auto">
              See Pricing
            </Button>
          </a>
        </div>
      </div>
    </section>
  );
}

/* ──────────────────────────── SOCIAL PROOF ──────────────────── */

function SocialProof() {
  const stats = [
    { value: '10,000+', label: 'Records per bulk upload' },
    { value: '90-Day', label: 'Smart deduplication cache' },
    { value: '$0', label: 'Charge for no-match results' },
  ];

  return (
    <section className="py-12 bg-white border-b border-gray-100">
      <div className="mx-auto max-w-5xl px-4 sm:px-6 grid grid-cols-1 sm:grid-cols-3 gap-8 text-center">
        {stats.map((s) => (
          <div key={s.label}>
            <p className="text-3xl font-bold text-[#1B3A5C]">{s.value}</p>
            <p className="mt-1 text-sm text-gray-500">{s.label}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ──────────────────────────── FEATURES ──────────────────────── */

const features = [
  {
    icon: Search,
    title: 'Single Property Trace',
    description: 'Enter an address and get owner phone numbers and emails back in seconds.',
  },
  {
    icon: FileUp,
    title: 'Bulk Upload',
    description: 'Upload up to 10,000 records via CSV or Excel. Auto-detect columns from CoStar, Reonomy, and more.',
  },
  {
    icon: Clock,
    title: 'Smart Deduplication',
    description: '90-day cache prevents double-charging. Previously traced addresses return cached results for free.',
  },
  {
    icon: Key,
    title: 'API Access',
    description: 'Integrate skip tracing directly into your workflow with our RESTful API.',
    badge: 'Pro',
  },
  {
    icon: LinkIcon,
    title: 'CRM Integration',
    description: 'Push traced contacts to HighLevel CRM or trigger webhooks to Zapier, Make, and more.',
    badge: 'Pro',
  },
  {
    icon: Wallet,
    title: 'Wallet Billing',
    description: 'Pre-fund your wallet and only pay for successful matches. Optional auto-refill so you never run out.',
  },
];

function Features() {
  return (
    <section id="features" className="py-20 bg-gray-50">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-14">
          <h2 className="text-3xl font-bold text-[#1B3A5C]">Everything You Need to Find Property Owners</h2>
          <p className="mt-3 text-gray-600 max-w-2xl mx-auto">
            Purpose-built for commercial real estate professionals who need reliable owner contact data.
          </p>
        </div>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <Card key={f.title} className="bg-white">
              <CardHeader className="flex flex-row items-start gap-3 space-y-0">
                <div className="rounded-lg bg-[#4A8CC7]/10 p-2">
                  <f.icon className="h-5 w-5 text-[#4A8CC7]" />
                </div>
                <div className="flex-1">
                  <CardTitle className="text-base flex items-center gap-2">
                    {f.title}
                    {f.badge && <Badge className="bg-purple-100 text-purple-700 text-xs">{f.badge}</Badge>}
                  </CardTitle>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-gray-600">{f.description}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ──────────────────────────── HOW IT WORKS ──────────────────── */

function HowItWorks() {
  const steps = [
    { icon: Upload, num: '1', title: 'Upload or Search', description: 'Enter a single address or upload a CSV with thousands of records.' },
    { icon: Search, num: '2', title: 'We Trace', description: 'Our engine finds owner names, phone numbers, and emails from multiple data sources.' },
    { icon: Download, num: '3', title: 'Get Results', description: 'View results instantly, download CSV, or push directly to your CRM.' },
  ];

  return (
    <section className="py-20 bg-white">
      <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-14">
          <h2 className="text-3xl font-bold text-[#1B3A5C]">How It Works</h2>
          <p className="mt-3 text-gray-600">Three simple steps from address to owner contact info.</p>
        </div>
        <div className="grid gap-10 md:grid-cols-3">
          {steps.map((s) => (
            <div key={s.num} className="text-center">
              <div className="mx-auto w-14 h-14 rounded-full bg-[#E8872A] flex items-center justify-center mb-4">
                <span className="text-xl font-bold text-white">{s.num}</span>
              </div>
              <h3 className="text-lg font-semibold text-[#1B3A5C]">{s.title}</h3>
              <p className="mt-2 text-sm text-gray-600">{s.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ──────────────────────────── PRICING ──────────────────────────── */

const plans = [
  {
    name: 'Pay-As-You-Go',
    price: '$0',
    period: '/mo',
    perTrace: '$0.11',
    description: 'No commitment. Fund your wallet and trace.',
    features: [
      'Single & bulk tracing',
      'Smart 90-day deduplication',
      'CSV download',
      'Wallet billing with auto-refill',
    ],
    cta: 'Get Started',
    highlight: false,
  },
  {
    name: 'Pro',
    price: '$97',
    period: '/mo',
    perTrace: '$0.07',
    description: 'For power users who need integrations and lower rates.',
    features: [
      'Everything in Pay-As-You-Go',
      'Lower per-trace rate ($0.07)',
      'API access',
      'HighLevel CRM integration',
      'Webhook automations',
    ],
    cta: 'Start Pro',
    highlight: true,
  },
  {
    name: 'AcquisitionPRO Members',
    price: '$0',
    period: '/mo',
    perTrace: '$0.07',
    description: 'Included with your AcquisitionPRO membership.',
    features: [
      'Everything in Pro',
      'Pro-rate pricing ($0.07)',
      'No monthly subscription fee',
      'Auto-verified membership',
    ],
    cta: 'Get Started',
    highlight: false,
  },
];

function Pricing() {
  return (
    <section id="pricing" className="py-20 bg-gray-50">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-14">
          <h2 className="text-3xl font-bold text-[#1B3A5C]">Simple, Transparent Pricing</h2>
          <p className="mt-3 text-gray-600">Pay only for successful matches. No charge for no-match results.</p>
        </div>
        <div className="grid gap-6 md:grid-cols-3 max-w-5xl mx-auto">
          {plans.map((p) => (
            <Card
              key={p.name}
              className={`relative ${p.highlight ? 'border-[#E8872A] border-2 shadow-lg' : ''}`}
            >
              {p.highlight && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <Badge className="bg-[#E8872A] text-white px-3">Most Popular</Badge>
                </div>
              )}
              <CardHeader className="text-center pt-8">
                <CardTitle className="text-lg text-[#1B3A5C]">{p.name}</CardTitle>
                <div className="mt-3">
                  <span className="text-4xl font-bold text-[#1B3A5C]">{p.price}</span>
                  <span className="text-gray-500">{p.period}</span>
                </div>
                <p className="mt-1 text-sm text-gray-500">+ {p.perTrace} per successful trace</p>
                <p className="mt-2 text-sm text-gray-600">{p.description}</p>
              </CardHeader>
              <CardContent className="pt-4">
                <ul className="space-y-3 mb-8">
                  {p.features.map((f) => (
                    <li key={f} className="flex items-start gap-2 text-sm text-gray-700">
                      <CheckCircle className="h-4 w-4 text-green-500 mt-0.5 shrink-0" />
                      {f}
                    </li>
                  ))}
                </ul>
                <Link href="/register" className="block">
                  <Button
                    className={`w-full ${
                      p.highlight
                        ? 'bg-[#E8872A] hover:bg-[#F09A45] text-white'
                        : 'bg-[#1B3A5C] hover:bg-[#234B75] text-white'
                    }`}
                  >
                    {p.cta}
                  </Button>
                </Link>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ──────────────────────────── FAQ ──────────────────────────── */

const faqs = [
  {
    q: 'What data do I get back from a trace?',
    a: 'Each successful trace returns the property owner name, up to 8 phone numbers (with type labels), up to 5 email addresses, and a mailing address when available.',
  },
  {
    q: 'Do I get charged if there is no match?',
    a: 'No. You are only charged for successful matches that return at least one phone number or email address.',
  },
  {
    q: 'What is the 90-day deduplication cache?',
    a: 'If you trace the same address within 90 days, we return the cached result at no charge. This prevents double-billing when re-uploading lists.',
  },
  {
    q: 'Can I upload Excel files?',
    a: 'Yes. We support CSV, XLS, and XLSX files. Our system auto-detects column mappings from common formats like CoStar, Reonomy, and county assessor exports.',
  },
  {
    q: 'How does wallet billing work?',
    a: 'You pre-fund your wallet with any amount. Each successful trace deducts from your balance. You can enable auto-refill to automatically top up when your balance gets low.',
  },
  {
    q: 'What is AcquisitionPRO membership?',
    a: 'AcquisitionPRO is a commercial real estate training and tools platform. Members get Pro-level access to PropTracerPRO at no monthly fee, with the lower $0.07 per-trace rate.',
  },
];

function FAQ() {
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  return (
    <section id="faq" className="py-20 bg-white">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-14">
          <h2 className="text-3xl font-bold text-[#1B3A5C]">Frequently Asked Questions</h2>
        </div>
        <div className="divide-y divide-gray-200">
          {faqs.map((faq, i) => (
            <div key={i}>
              <button
                className="w-full flex items-center justify-between py-5 text-left"
                onClick={() => setOpenIdx(openIdx === i ? null : i)}
              >
                <span className="text-base font-medium text-gray-900">{faq.q}</span>
                {openIdx === i ? (
                  <ChevronUp className="h-5 w-5 text-gray-400 shrink-0 ml-4" />
                ) : (
                  <ChevronDown className="h-5 w-5 text-gray-400 shrink-0 ml-4" />
                )}
              </button>
              {openIdx === i && (
                <p className="pb-5 text-sm text-gray-600 leading-relaxed">{faq.a}</p>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ──────────────────────────── FINAL CTA ──────────────────────── */

function FinalCTA() {
  return (
    <section className="py-20 bg-[#1B3A5C]">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 text-center">
        <h2 className="text-3xl font-bold text-white">Ready to Find Property Owners?</h2>
        <p className="mt-4 text-lg text-gray-300">
          Create a free account and start tracing in minutes. No credit card required to sign up.
        </p>
        <div className="mt-8">
          <Link href="/register">
            <Button size="lg" className="bg-[#E8872A] hover:bg-[#F09A45] text-white text-lg px-10 py-6">
              Start Tracing Free
            </Button>
          </Link>
        </div>
      </div>
    </section>
  );
}

/* ──────────────────────────── FOOTER ──────────────────────────── */

function LandingFooter() {
  return (
    <footer className="bg-[#1B3A5C] border-t border-[#234B75] py-8">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 text-center text-sm text-gray-400 space-y-2">
        <p>&copy;2026 Premier Apartment Services, LLC - dba PropTracerPRO&trade; All Rights Reserved</p>
        <p>853 Dauphin St. Suite C Mobile, AL 36602</p>
        <p>
          <a href="https://goacquisitionpro.com/privacy-policy" target="_blank" rel="noopener noreferrer" className="underline hover:text-gray-200">
            Privacy Policy
          </a>
          {' | '}
          <a href="https://goacquisitionpro.com/terms-conditions" target="_blank" rel="noopener noreferrer" className="underline hover:text-gray-200">
            Terms &amp; Conditions
          </a>
        </p>
      </div>
    </footer>
  );
}

/* ──────────────────────────── MAIN EXPORT ──────────────────────── */

export function LandingPage() {
  return (
    <div className="min-h-screen bg-white">
      <Nav />
      <Hero />
      <SocialProof />
      <Features />
      <HowItWorks />
      <Pricing />
      <FAQ />
      <FinalCTA />
      <LandingFooter />
    </div>
  );
}
