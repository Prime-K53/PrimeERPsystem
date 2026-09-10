import React from 'react';
import PrintingContractsView from '../printing-contracts/PrintingContractsView';

/**
 * Route wrapper (formerly the Subscriptions / recurring-billing tab).
 * The tab is renamed to "Printing Contracts" per the printing-contract
 * domain design + implementation plan. Legacy `recurring_invoices` rows
 * remain visible read-only inside the view's archive section (§14).
 */
const SubscriptionsView: React.FC = () => <PrintingContractsView />;

export default SubscriptionsView;
