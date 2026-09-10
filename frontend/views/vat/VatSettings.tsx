import React, { useEffect, useState } from 'react';
import { useVatStore } from '../../stores/vatStore';
import { useFinanceStore } from '../../stores/financeStore';
import { VATConfig } from '../../types';
import { Save, Settings as SettingsIcon } from 'lucide-react';

/* Shared Add-Customer chrome — single source of truth for all Finance Hub tabs */
import {
    teal, paper, ink, inkSoft, hairline,
    labelStyle, inputStyle, selectStyle, sectionLabelStyle,
    btnPrimaryStyle, tableCard,
} from '../accounts/components/financeChrome';

export const VatSettings: React.FC = () => {
    const { config, updateConfig, isLoading } = useVatStore();
    const { accounts, fetchFinanceData } = useFinanceStore();
    const [localConfig, setLocalConfig] = useState<VATConfig>(config);
    const [isDirty, setIsDirty] = useState(false);

    useEffect(() => { fetchFinanceData(); }, []);
    useEffect(() => { setLocalConfig(config); }, [config]);

    const handleChange = (field: keyof VATConfig, value: any) => { setLocalConfig(prev => ({ ...prev, [field]: value })); setIsDirty(true); };

    const handleSave = async () => { await updateConfig(localConfig); setIsDirty(false); };

    const liabAccts = accounts.filter(a => a.type === 'Liability');
    const assetAccts = accounts.filter(a => a.type === 'Asset');

    return (
        <div style={{ ...tableCard, padding: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
                <div style={{
                    width: 40, height: 40, borderRadius: 10,
                    background: `linear-gradient(155deg, ${teal[500]}, ${teal[700]})`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    boxShadow: '0 4px 10px -3px rgba(15,84,76,.6)', flexShrink: 0
                }}>
                    <SettingsIcon size={19} color="#fff" />
                </div>
                <div>
                    <h2 style={{ fontFamily: "'DM Serif Display', 'Georgia', serif", fontWeight: 400, fontSize: 22, color: teal[800], margin: 0, letterSpacing: 0.2 }}>VAT settings</h2>
                    <p style={{ margin: '2px 0 0', fontSize: 11.5, color: inkSoft }}>Rates, registration & GL account mapping</p>
                </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                <div style={sectionLabelStyle}><span>Rates & Registration</span></div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                    <div>
                        <label style={labelStyle}>Standard rate (%) <span style={{ color: '#b5493f', fontWeight: 700 }}>*</span></label>
                        <div style={{ position: 'relative' }}>
                            <input type="number" required min="0" step="0.01" value={localConfig.rate} onChange={(e) => handleChange('rate', parseFloat(e.target.value))} style={{ ...inputStyle, paddingRight: 34, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }} />
                            <span style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', color: inkSoft, fontWeight: 700, fontSize: 13 }}>%</span>
                        </div>
                        <p style={{ fontSize: 11, color: inkSoft, marginTop: 4 }}>Malawi standard rate: 17.5%</p>
                    </div>
                    <div>
                        <label style={labelStyle}>Registration number (TPIN)</label>
                        <input type="text" value={localConfig.registrationNumber || ''} onChange={(e) => handleChange('registrationNumber', e.target.value)} style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace" }} placeholder="e.g. 100012345" />
                    </div>
                    <div>
                        <label style={labelStyle}>Filing frequency</label>
                        <select value={localConfig.filingFrequency} onChange={(e) => handleChange('filingFrequency', e.target.value)} style={selectStyle}>
                            <option value="Monthly">Monthly</option>
                            <option value="Quarterly">Quarterly</option>
                            <option value="Annually">Annually</option>
                        </select>
                    </div>
                    <div>
                        <label style={labelStyle}>Default tax category</label>
                        <select value={localConfig.defaultTaxCategory || 'Standard'} onChange={(e) => handleChange('defaultTaxCategory', e.target.value)} style={selectStyle}>
                            <option value="Standard">Standard rate</option>
                            <option value="Zero">Zero rated</option>
                            <option value="Exempt">Exempt</option>
                        </select>
                    </div>
                </div>
                <div style={sectionLabelStyle}><span>GL Account Mapping</span></div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                    <div>
                        <label style={labelStyle}>Output tax account (collected)</label>
                        <select value={localConfig.outputTaxAccount || ''} onChange={(e) => handleChange('outputTaxAccount', e.target.value)} style={selectStyle}>
                            <option value="">Select liability account</option>
                            {liabAccts.map(a => (<option key={a.id} value={a.id}>{a.code} - {a.name}</option>))}
                        </select>
                        <p style={{ fontSize: 11, color: inkSoft, marginTop: 4 }}>Account for VAT collected on sales</p>
                    </div>
                    <div>
                        <label style={labelStyle}>Input tax account (paid)</label>
                        <select value={localConfig.inputTaxAccount || ''} onChange={(e) => handleChange('inputTaxAccount', e.target.value)} style={selectStyle}>
                            <option value="">Select asset account</option>
                            {assetAccts.map(a => (<option key={a.id} value={a.id}>{a.code} - {a.name}</option>))}
                        </select>
                        <p style={{ fontSize: 11, color: inkSoft, marginTop: 4 }}>Account for VAT paid on purchases</p>
                    </div>
                    <div>
                        <label style={labelStyle}>Market adjustment account
                            <span style={{ fontSize: 9.5, fontWeight: 600, color: inkSoft, background: teal[50], padding: '1px 6px', borderRadius: 20, letterSpacing: 0.03, textTransform: 'uppercase', marginLeft: 6 }}>Optional</span>
                        </label>
                        <select value={localConfig.marketAdjustmentAccount || ''} onChange={(e) => handleChange('marketAdjustmentAccount', e.target.value)} style={selectStyle}>
                            <option value="">Select revenue/other account</option>
                            {accounts.filter(a => a.type === 'Revenue').map(a => (<option key={a.id} value={a.id}>{a.code} - {a.name}</option>))}
                        </select>
                        <p style={{ fontSize: 11, color: inkSoft, marginTop: 4 }}>Account for tracking market adjustments</p>
                    </div>
                </div>
                <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end', borderTop: `1px solid ${hairline}`, paddingTop: 16 }}>
                    <button onClick={handleSave} disabled={!isDirty || isLoading}
                        style={{ ...btnPrimaryStyle, opacity: (!isDirty || isLoading) ? 0.55 : 1 }}
                        onMouseEnter={e => { if (isDirty && !isLoading) e.currentTarget.style.transform = 'translateY(-1px)'; }}
                        onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; }}
                    ><Save size={16} /> {isLoading ? 'Saving...' : 'Save configuration'}</button>
                </div>
            </div>
        </div>
    );
};
