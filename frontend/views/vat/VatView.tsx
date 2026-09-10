import React, { useState } from 'react';
import { LayoutDashboard, FileText, Settings } from 'lucide-react';
import { VatDashboard } from './VatDashboard';
import { VatReports } from './VatReports';
import { VatSettings } from './VatSettings';

/* Shared Add-Customer chrome — single source of truth for all Finance Hub tabs */
import {
    teal, paper, inkSoft, hairline,
    PageHeader,
} from '../accounts/components/financeChrome';

const VatView: React.FC = () => {
    const [activeTab, setActiveTab] = useState<'Dashboard' | 'Reports' | 'Settings'>('Dashboard');

    return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: paper }}>
            <PageHeader
                icon={<FileText size={19} color="#fff" />}
                title="VAT Management"
                subtitle="VAT on sales & purchases — returns, payments & configuration"
                actions={
                    <div style={{ display: 'flex', gap: 4, background: teal[50], padding: 4, borderRadius: 12, border: `1.4px solid ${hairline}` }}>
                        {(['Dashboard', 'Reports', 'Settings'] as const).map(tab => (
                            <button key={tab} onClick={() => setActiveTab(tab)}
                                style={{
                                    padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                                    border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8,
                                    background: activeTab === tab ? paper : 'transparent',
                                    color: activeTab === tab ? teal[600] : inkSoft,
                                    boxShadow: activeTab === tab ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                                    transition: 'all .15s ease'
                                }}
                                onMouseEnter={e => { if (activeTab !== tab) { e.currentTarget.style.color = teal[800]; e.currentTarget.style.background = '#fff'; } }}
                                onMouseLeave={e => { if (activeTab !== tab) { e.currentTarget.style.color = inkSoft; e.currentTarget.style.background = 'transparent'; } }}
                            >
                                {tab === 'Dashboard' && <LayoutDashboard size={16} />}
                                {tab === 'Reports' && <FileText size={16} />}
                                {tab === 'Settings' && <Settings size={16} />}
                                {tab === 'Reports' ? 'Returns & reports' : tab === 'Settings' ? 'Configuration' : 'Dashboard'}
                            </button>
                        ))}
                    </div>
                }
            />
            <div style={{ flex: 1, overflow: 'auto', padding: 24, background: paper }}>
                {activeTab === 'Dashboard' && <VatDashboard />}
                {activeTab === 'Reports' && <VatReports />}
                {activeTab === 'Settings' && <VatSettings />}
            </div>
        </div>
    );
};

export default VatView;
