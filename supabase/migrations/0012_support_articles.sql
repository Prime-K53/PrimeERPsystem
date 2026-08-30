-- Migration: 0012_support_articles.sql
-- Support FAQ articles table for customer portal
-- Replaces the hard-coded SUPPORT_ARTICLES array in portalService.cjs

CREATE TABLE IF NOT EXISTS public.support_articles (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'General',
  tags TEXT[] NOT NULL DEFAULT '{}',
  helpful INTEGER NOT NULL DEFAULT 0,
  not_helpful INTEGER NOT NULL DEFAULT 0,
  last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INTEGER NOT NULL DEFAULT 0
);

-- Index for category listing
CREATE INDEX IF NOT EXISTS idx_support_articles_category ON public.support_articles (category);

-- Index for slug lookups
CREATE INDEX IF NOT EXISTS idx_support_articles_slug ON public.support_articles (slug);

-- RLS: anyone can read, only authenticated staff can modify
ALTER TABLE public.support_articles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Support articles are viewable by everyone" ON public.support_articles;
CREATE POLICY "Support articles are viewable by everyone"
  ON public.support_articles FOR SELECT TO authenticated, anon, service_role
  USING (true);

DROP POLICY IF EXISTS "Support articles can be managed by staff" ON public.support_articles;
CREATE POLICY "Support articles can be managed by staff"
  ON public.support_articles FOR ALL TO authenticated
  USING (true)
  WITH CHECK (true);

-- Seed with Prime Printing FAQ (replaceable by staff)
INSERT INTO public.support_articles (id, slug, title, summary, body, category, tags, helpful, not_helpful, last_updated) VALUES
  ('ART-001', 'about-prime-printing', 'What does Prime Printing do?', 'Prime Printing provides professional printing and stationery solutions for individuals, businesses, schools, organisations, and institutions.', 'Prime Printing provides professional printing and stationery solutions for individuals, businesses, schools, organisations, and institutions.

Our services include general printing, business and office stationery, promotional materials, examination-related printing, document printing, customised print jobs, and other printing requirements.', 'About Prime Printing', ARRAY['about', 'services'], 0, 0, NOW()),
  ('ART-002', 'who-can-order', 'Who can order from Prime Printing?', 'Anyone can request our printing services.', 'Anyone can request our printing services. We serve individuals, businesses, schools, organisations, NGOs, institutions, and other customers with printing and stationery needs.', 'About Prime Printing', ARRAY['orders', 'customers'], 0, 0, NOW()),
  ('ART-003', 'location', 'Where is Prime Printing located?', 'Prime Printing operates in Malawi.', 'Please contact our team or check the contact information provided in your customer account for our current location and collection arrangements.', 'About Prime Printing', ARRAY['location', 'contact'], 0, 0, NOW()),
  ('ART-004', 'request-quotation', 'How do I request a quotation?', 'Contact Prime Printing with details of what you need printed.', 'You can contact Prime Printing with details of what you need printed, including the product, quantity, size, material, finishing requirements, and preferred deadline.

Where available, you can also submit a quotation request through the Prime Portal.', 'Orders & Quotations', ARRAY['quotation', 'request'], 0, 0, NOW()),
  ('ART-005', 'quotation-info', 'What information should I provide when requesting a quotation?', 'Provide details about what you want printed, quantity, size, colour requirements, and more.', 'For the most accurate quotation, provide:

- What you want printed
- Quantity required
- Size
- Colour or black-and-white requirements
- Paper/material preference
- Finishing requirements
- Whether artwork/design is ready
- Your required completion date
- Delivery or collection preference', 'Orders & Quotations', ARRAY['quotation', 'details'], 0, 0, NOW()),
  ('ART-006', 'quotation-vs-order', 'Is a quotation the same as an order?', 'No. A quotation shows the estimated price; an order is created when the quotation is accepted.', 'No.

A quotation shows the estimated price and details of the requested work. An order is created when the quotation/request is accepted and the job proceeds through the appropriate Prime Printing process.', 'Orders & Quotations', ARRAY['quotation', 'order'], 0, 0, NOW()),
  ('ART-007', 'change-order', 'Can I change my order after submitting it?', 'Contact Prime Printing as soon as possible.', 'Contact Prime Printing as soon as possible.

Changes may affect the price, production time, materials, or delivery date. Once production has started, some changes may no longer be possible or may incur additional costs.', 'Orders & Quotations', ARRAY['order', 'changes'], 0, 0, NOW()),
  ('ART-008', 'cancel-order', 'Can I cancel an order?', 'Cancellation depends on the stage of the order.', 'Cancellation depends on the stage of the order.

Contact Prime Printing immediately if you need to cancel. Orders that have already entered production may be subject to applicable charges.', 'Orders & Quotations', ARRAY['order', 'cancellation'], 0, 0, NOW()),
  ('ART-009', 'artwork-required', 'Do I need to provide my own artwork?', 'Not necessarily. You can provide print-ready artwork or ask about design assistance.', 'Not necessarily.

If you already have print-ready artwork, you can provide it to us. If you need design or artwork preparation assistance, ask our team about the available options.', 'Artwork & Design', ARRAY['artwork', 'design'], 0, 0, NOW()),
  ('ART-010', 'file-formats', 'What file formats can I provide?', 'Common print-ready formats such as PDF are preferred.', 'Common print-ready formats such as PDF are preferred. Depending on the job, other formats may also be accepted.

If you are unsure whether your file is suitable for printing, contact us before placing the order.', 'Artwork & Design', ARRAY['artwork', 'files'], 0, 0, NOW()),
  ('ART-011', 'artwork-check', 'Will my artwork be checked before printing?', 'Artwork may be reviewed for basic production requirements.', 'Where applicable, artwork may be reviewed for basic production requirements.

Customers should carefully check spelling, names, dates, quantities, colours, logos, contact details, and other information before approving artwork for production.', 'Artwork & Design', ARRAY['artwork', 'quality'], 0, 0, NOW()),
  ('ART-012', 'design-services', 'Can Prime Printing design my material?', 'Yes, where design services are available.', 'Yes, where design services are available.

You can discuss your requirements with our team before production begins.', 'Artwork & Design', ARRAY['design', 'services'], 0, 0, NOW()),
  ('ART-013', 'pricing-factors', 'How is the price of a printing job calculated?', 'Pricing may depend on quantity, size, paper, colour requirements, and more.', 'Pricing may depend on:

- Quantity
- Size
- Paper/material
- Colour requirements
- Printing method
- Finishing
- Binding
- Artwork/design requirements
- Packaging
- Delivery
- Production time

For customised jobs, the final price is normally confirmed through a quotation.', 'Pricing', ARRAY['pricing', 'quotation'], 0, 0, NOW()),
  ('ART-014', 'similar-prices', 'Why can two similar printing jobs have different prices?', 'Small differences in specifications can affect the cost.', 'Small differences in quantity, paper, size, colour, finishing, artwork, or production requirements can affect the cost.', 'Pricing', ARRAY['pricing'], 0, 0, NOW()),
  ('ART-015', 'final-price', 'Is the price shown in my quotation final?', 'The quotation represents the price for the stated specifications.', 'The quotation represents the price for the specifications stated in it.

If you change the specifications, quantity, artwork, delivery requirements, or other important details, the quotation may need to be revised.', 'Pricing', ARRAY['pricing', 'quotation'], 0, 0, NOW()),
  ('ART-016', 'printing-types', 'What types of printing does Prime Printing offer?', 'We offer business cards, flyers, posters, brochures, books, stationery, and more.', 'Depending on the job, Prime Printing can provide:

- Business cards
- Flyers
- Posters
- Brochures
- Books and booklets
- Reports
- Certificates
- Forms
- Receipt books
- Office stationery
- School stationery
- Examination materials
- Branded materials
- General document printing
- Other customised printing', 'Printing & Products', ARRAY['products', 'services'], 0, 0, NOW()),
  ('ART-017', 'large-orders', 'Can Prime Printing handle large orders?', 'Yes. Large or recurring orders can be discussed with our team.', 'Yes. Large or recurring orders can be discussed with our team so production requirements, pricing, and delivery schedules can be properly planned.', 'Printing & Products', ARRAY['orders', 'large'], 0, 0, NOW()),
  ('ART-018', 'recurring-orders', 'Can I place recurring orders?', 'Yes, where applicable. Regular orders can be processed more efficiently.', 'Yes, where applicable.

If you regularly require the same stationery or printed materials, let our team know so future orders can be processed more efficiently.', 'Printing & Products', ARRAY['orders', 'recurring'], 0, 0, NOW()),
  ('ART-019', 'delivery', 'Do you offer delivery?', 'Delivery may be available depending on the order and delivery location.', 'Delivery may be available depending on the order and delivery location.

Delivery arrangements and applicable charges should be confirmed when the order is processed.', 'Delivery & Collection', ARRAY['delivery'], 0, 0, NOW()),
  ('ART-020', 'collection', 'Can I collect my order?', 'Yes, where collection is offered.', 'Yes, where collection is offered for the particular order.

Your order status or our team will indicate when your order is ready for collection.', 'Delivery & Collection', ARRAY['collection'], 0, 0, NOW()),
  ('ART-021', 'turnaround-time', 'How long will my order take?', 'Turnaround time depends on the type and quantity of work.', 'Turnaround time depends on the type and quantity of work, artwork requirements, production workload, finishing, and delivery requirements.

Your expected completion date should be confirmed with the quotation or order.', 'Delivery & Collection', ARRAY['turnaround', 'time'], 0, 0, NOW()),
  ('ART-022', 'urgent-orders', 'Can I request an urgent order?', 'You can ask our team about urgent production.', 'You can ask our team about urgent production.

Urgent jobs depend on production capacity and job requirements. An additional charge may apply where expedited production is available.', 'Delivery & Collection', ARRAY['urgent', 'rush'], 0, 0, NOW()),
  ('ART-023', 'prime-portal', 'What is the Prime Portal?', 'Prime Printing customer-facing online platform for managing your account.', 'The Prime Portal is Prime Printing''s customer-facing online platform.

Depending on your account and available services, you can use it to view and manage:

- Quotations
- Orders
- Invoices
- Payment requests
- Account information
- Referral information
- Order status', 'Prime Customer Portal', ARRAY['portal', 'account'], 0, 0, NOW()),
  ('ART-024', 'portal-account', 'Do I need a Portal account to use Prime Printing?', 'Not every interaction requires a Portal account.', 'Not every interaction necessarily requires a Portal account.

If Prime Printing has provided or enabled Portal access for you, your Portal account gives you convenient access to your customer information and transactions.', 'Prime Customer Portal', ARRAY['portal', 'account'], 0, 0, NOW()),
  ('ART-025', 'forgot-password', 'I forgot my password. What should I do?', 'Use the password recovery option on the Portal.', 'Use the password recovery option on the Portal.

If you cannot recover your account, contact Prime Printing support.', 'Prime Customer Portal', ARRAY['password', 'account'], 0, 0, NOW()),
  ('ART-026', 'order-history', 'Can I see my previous orders?', 'Where your account has Portal access, you can view order history.', 'Where your account has Portal access and the relevant records are available, you can view your order history through the Portal.', 'Prime Customer Portal', ARRAY['orders', 'history'], 0, 0, NOW()),
  ('ART-027', 'invoices-online', 'Can I see my invoices online?', 'Yes, invoices can be made available through the Portal.', 'Yes, invoices associated with your customer account can be made available through the Portal.', 'Prime Customer Portal', ARRAY['invoices', 'portal'], 0, 0, NOW()),
  ('ART-028', 'request-not-order', 'Does submitting an online request automatically mean my job has started?', 'No. A request does not necessarily mean production has started.', 'No.

A request or quotation submission does not necessarily mean production has started. The order must go through the appropriate confirmation and processing stages.', 'Prime Customer Portal', ARRAY['requests', 'orders'], 0, 0, NOW()),
  ('ART-029', 'payment-methods', 'How can I pay for my order?', 'Available payment methods depend on arrangements provided by Prime Printing.', 'Available payment methods depend on the arrangements provided by Prime Printing.

Your invoice or payment instructions should indicate the appropriate payment method.', 'Payments', ARRAY['payment', 'invoices'], 0, 0, NOW()),
  ('ART-030', 'payment-request', 'What is a payment request?', 'A payment request is a request relating to payment for an outstanding transaction.', 'A payment request is a request relating to payment for an outstanding transaction.

Submitting a payment request does not by itself mean payment has been received or that an invoice has been paid.', 'Payments', ARRAY['payment', 'request'], 0, 0, NOW()),
  ('ART-031', 'invoice-unpaid', 'Why does my invoice still show as unpaid after I submit a payment request?', 'A payment request and actual payment are different things.', 'A payment request and an actual recorded payment are different things.

Payment must be received and recorded by Prime Printing before the invoice status is updated as paid.', 'Payments', ARRAY['invoice', 'payment'], 0, 0, NOW()),
  ('ART-032', 'paid-balance', 'What should I do if I have already paid but my account still shows an outstanding balance?', 'Contact Prime Printing with your payment information or proof of payment.', 'Contact Prime Printing and provide the relevant payment information or proof of payment.

Our team can verify and update the payment record where appropriate.', 'Payments', ARRAY['payment', 'balance'], 0, 0, NOW()),
  ('ART-033', 'referral-programme', 'Does Prime Printing have a referral programme?', 'Yes, Prime Printing may provide a referral programme.', 'Yes, Prime Printing may provide a referral programme that allows eligible customers to refer new customers.', 'Referrals', ARRAY['referral', 'programme'], 0, 0, NOW()),
  ('ART-034', 'referral-how', 'How does the referral programme work?', 'An eligible customer can share their referral link or code with someone interested.', 'An eligible customer can share their referral link or referral code with someone interested in using Prime Printing.

When the referred customer registers and completes the required qualifying activity, the referral may become eligible for the applicable reward.', 'Referrals', ARRAY['referral', 'programme'], 0, 0, NOW()),
  ('ART-035', 'referral-reward', 'Does every referral automatically earn a reward?', 'No. A referral must satisfy the programme''s qualifying conditions.', 'No.

A referral must satisfy the programme''s qualifying conditions before a reward is issued.', 'Referrals', ARRAY['referral', 'reward'], 0, 0, NOW()),
  ('ART-036', 'self-referral', 'Can I refer myself?', 'No. Self-referrals are not eligible.', 'No.

Self-referrals are not eligible.', 'Referrals', ARRAY['referral'], 0, 0, NOW()),
  ('ART-037', 'referral-discount', 'Can I receive the first-order referral discount more than once?', 'No. The first-order referral discount is intended for the referred customer''s first order.', 'No.

The first-order referral discount is intended for the referred customer''s qualifying first order and should not be repeatedly applied to subsequent orders.', 'Referrals', ARRAY['referral', 'discount'], 0, 0, NOW()),
  ('ART-038', 'referral-credit', 'When will my referral reward be credited?', 'The reward becomes eligible after the referred customer completes the required qualifying order lifecycle.', 'The reward becomes eligible after the referred customer completes the required qualifying order lifecycle.

Once qualified, the applicable reward is processed according to Prime Printing''s referral programme rules.', 'Referrals', ARRAY['referral', 'reward'], 0, 0, NOW()),
  ('ART-039', 'referral-reversed', 'What happens if a qualifying order is cancelled or reversed?', 'A referral reward associated with a qualifying order may be reversed.', 'A referral reward associated with a qualifying order may be reversed where the underlying transaction is cancelled or otherwise becomes ineligible.', 'Referrals', ARRAY['referral', 'cancelled'], 0, 0, NOW()),
  ('ART-040', 'account-security', 'Is my customer information secure?', 'Prime Printing takes reasonable measures to protect customer information.', 'Prime Printing takes reasonable measures to protect customer account and transaction information.

Customers should also keep their passwords confidential and should not share their login credentials.', 'Account & Security', ARRAY['security', 'account'], 0, 0, NOW()),
  ('ART-041', 'other-customer', 'Can another customer see my orders or invoices?', 'No. Your customer information is intended to remain associated with your own account.', 'No. Your customer information is intended to remain associated with your own account.', 'Account & Security', ARRAY['privacy', 'account'], 0, 0, NOW()),
  ('ART-042', 'incorrect-info', 'What should I do if I notice something incorrect in my account?', 'Contact Prime Printing support as soon as possible.', 'Contact Prime Printing support as soon as possible and provide the relevant order, quotation, invoice, or transaction details.', 'Account & Security', ARRAY['support', 'account'], 0, 0, NOW()),
  ('ART-043', 'wrong-job', 'What if the printed job is different from what I approved?', 'Contact Prime Printing promptly with your order details.', 'Contact Prime Printing promptly.

Provide the order details and explain the issue. Our team will review the approved specifications and delivered work.', 'Problems & Support', ARRAY['support', 'issue'], 0, 0, NOW()),
  ('ART-044', 'spelling-error', 'What if there is a spelling or information error in my printed material?', 'Customers are strongly encouraged to carefully proofread and approve all artwork.', 'If the error was present in the artwork or information approved by the customer, responsibility may depend on the circumstances.

Customers are strongly encouraged to carefully proofread and approve all artwork before production.', 'Problems & Support', ARRAY['quality', 'artwork'], 0, 0, NOW()),
  ('ART-045', 'fewer-items', 'What if I receive fewer items than I ordered?', 'Contact Prime Printing with your order details.', 'Contact Prime Printing with your order details so production and delivery records can be checked.', 'Problems & Support', ARRAY['order', 'issue'], 0, 0, NOW()),
  ('ART-046', 'order-delayed', 'What if my order is delayed?', 'Check the order status through the Portal or contact Prime Printing support.', 'Check the order status through the Portal where available, or contact Prime Printing support.

Delays can occur because of artwork approval, material availability, production requirements, order changes, or other circumstances.', 'Problems & Support', ARRAY['order', 'delay'], 0, 0, NOW())
ON CONFLICT (id) DO UPDATE SET
  slug = EXCLUDED.slug,
  title = EXCLUDED.title,
  summary = EXCLUDED.summary,
  body = EXCLUDED.body,
  category = EXCLUDED.category,
  tags = EXCLUDED.tags,
  helpful = EXCLUDED.helpful,
  not_helpful = EXCLUDED.not_helpful,
  last_updated = EXCLUDED.last_updated;
