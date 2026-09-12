import React, { useState, useMemo, useEffect, useRef } from 'react';
import { logger } from '@/services/logger';
import { useNavigate } from 'react-router-dom';
import {
  X, Plus, Download,
  RefreshCw, Check, Copy, Pencil,
  ShieldAlert, FileDown,
} from 'lucide-react';
import { getCustomerDisplayName } from '../../../utils/customerDisplay';
import { pdf } from '@react-pdf/renderer';
import { PrimeDocument } from '../../shared/components/PDF/PrimeDocument';
import { generatePrimeDocumentBlob } from '../../shared/components/PDF/generatePrimeDocumentBlob';
import { getStoredCompanyConfig, initializePrimePdfFonts } from '../../shared/components/PDF/templateSettings';
import { ReceiptSchema, StatementDoc, type PrimeDocData } from '../../shared/components/PDF/schemas';
import { mapToInvoiceData } from '../../../utils/pdfMapper';
import { enrichDocumentCustomerData } from '../../../utils/documentCustomerData';
import { buildCustomerReceiptDoc } from '../../../services/receiptCalculationService';
import { hydrateCompanyPdfAssets } from '../../../utils/companyAssetUtils';
import { downloadBlob } from '../../../utils/helpers';
import type { Customer, CustomerDocument } from '../../../types';
import { customerDocumentsService, formatCustomerDocSize } from '../../../services/customerDocumentsService';
import { useSales } from '../../../context/SalesContext';
import { useFinance } from '../../../context/FinanceContext';
import { useAuth } from '../../../context/AuthContext';
import { useData, REFRESH_INTERVAL } from '../../../context/DataContext';
import { useModuleRefresh } from '../../../hooks/useModuleRefresh';
import { format, parseISO, isAfter, subMonths } from 'date-fns';
import { attachDocumentSecurity } from '../../../utils/documentSecurity';
import { currencyService } from '../../../services/currencyService';
import { referralService } from '../../../services/referralService';
import type { Referral, ReferralReward } from '../../../types/referral';
import { buildLedgerFromRecords } from '../../../services/customerLedger';
import { adminLifecycle, type PortalCredentials } from '../../../services/adminPortalClient';

interface CustomerWorkspaceProps {
  customer: Customer;
  onBack: () => void;
  onEdit: (customer: Customer) => void;
}

type RefTab = 'overview' | 'invoices' | 'payments' | 'accounting' | 'wallet' | 'referrals' | 'documents' | 'activity';

const PROFILE_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=Space+Grotesk:wght@400;500;600;700&display=swap');

.cp-root{
  --ink:#1C2321; --paper:#EDE9DD; --card:#FBFAF6; --line:#DEDACB; --line-soft:#E9E5D8;
  --teal:#1F5F53; --teal-deep:#153F37; --teal-bg:#E4EEEA;
  --amber:#A8631E; --amber-bg:#F5E9DA; --red:#C0392B; --red-bg:#F3E1DC;
  --green:#15803D; --muted:#726F63; --cream:#F4F0E4;
  min-height:100vh; background:var(--paper);
  font-family:'Space Grotesk',sans-serif; color:var(--ink);
  -webkit-font-smoothing:antialiased;
}
.cp-root a{color:inherit;text-decoration:none;}
.cp-root button{font-family:inherit;}

/* ============ top bar ============ */
.cp-topbar{
  display:flex;align-items:center;justify-content:space-between;
  padding:8px 20px; gap:16px;
  border-bottom:1px solid var(--line);
  background:var(--card);
  position:sticky; top:0; z-index:40;
}
.cp-breadcrumb{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted);min-width:0;flex:1;}
.cp-breadcrumb a{color:var(--muted);white-space:nowrap;}
.cp-breadcrumb a:hover{color:var(--ink);}
.cp-breadcrumb button.cp-crumb-btn{background:none;border:none;padding:0;font-size:13px;color:var(--muted);cursor:pointer;white-space:nowrap;}
.cp-breadcrumb button.cp-crumb-btn:hover{color:var(--ink);}
.cp-breadcrumb .cp-sep{opacity:.5;flex:none;}
.cp-breadcrumb .cp-current{color:var(--ink);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.cp-topbar-actions{display:flex;gap:10px;align-items:center;flex:none;}
.cp-btn{
  font-size:13px;font-weight:500;padding:9px 14px;border-radius:8px;cursor:pointer;
  display:flex;align-items:center;gap:7px;
  transition:background .15s ease,border-color .15s ease,transform .1s ease;
  border:1px solid transparent; white-space:nowrap;
}
.cp-btn:active{transform:scale(.97);}
.cp-btn svg{width:14px;height:14px;flex:none;}
.cp-btn-primary{background:var(--ink);color:var(--cream);border-color:var(--ink);}
.cp-btn-primary:hover{background:#000;}
.cp-btn-secondary{background:transparent;color:var(--ink);border-color:var(--line);}
.cp-btn-secondary:hover{border-color:var(--ink);background:var(--cream);}
.cp-btn-ghost{background:transparent;color:var(--muted);border-color:transparent;padding:9px;}
.cp-btn-ghost:hover{background:var(--line-soft);color:var(--ink);}
.cp-kebab-wrap{position:relative;}
.cp-kebab-menu{
  position:absolute;right:0;top:calc(100% + 8px);width:230px;
  background:var(--card);border:1px solid var(--line);border-radius:12px;
  box-shadow:0 16px 40px -12px rgba(21,33,29,.32);overflow:hidden;z-index:60;
  animation:cpPop .14s ease;
}
@keyframes cpPop{from{opacity:0;transform:translateY(-4px);}to{opacity:1;transform:none;}}
.cp-kebab-menu button{
  display:flex;width:100%;align-items:center;gap:10px;padding:10px 14px;
  background:transparent;border:none;border-bottom:1px solid var(--line-soft);
  font-size:12.5px;font-weight:500;color:var(--ink);cursor:pointer;text-align:left;
}
.cp-kebab-menu button:last-child{border-bottom:none;}
.cp-kebab-menu button:hover{background:var(--teal-bg);color:var(--teal);}
.cp-kebab-menu button svg{width:14px;height:14px;}
.cp-kebab-menu .cp-sep{height:1px;background:var(--line-soft);}

/* ============ page layout ============ */
.cp-page{
  max-width:none;margin:0;padding:20px 20px 48px;
  display:grid;grid-template-columns:300px 1fr;gap:20px;align-items:start;
}

/* ============ left column ============ */
.cp-side{position:sticky;top:80px;display:flex;flex-direction:column;gap:16px;min-width:0;}
.cp-panel{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden;}
.cp-profile-head{
  background:linear-gradient(155deg, var(--teal-deep), var(--teal) 130%);
  padding:22px 20px 18px;color:var(--cream);position:relative;overflow:hidden;
}
.cp-profile-head::before{
  content:"";position:absolute;inset:0;
  background-image:repeating-linear-gradient(115deg, rgba(255,255,255,.05) 0 2px, transparent 2px 26px);
}
.cp-avatar-lg{
  position:relative;width:52px;height:52px;border-radius:50%;
  background:var(--cream);color:var(--teal-deep);
  display:flex;align-items:center;justify-content:center;
  font-family:'Fraunces',serif;font-weight:700;font-size:18px;
  box-shadow:0 0 0 3px rgba(244,240,228,.22);margin-bottom:12px;
}
.cp-profile-head h1{
  position:relative;font-family:'Fraunces',serif;font-weight:600;font-size:19px;
  margin:0 0 6px;line-height:1.25;overflow:hidden;text-overflow:ellipsis;
}
.cp-profile-head .cp-meta{
  position:relative;font-size:12px;color:rgba(244,240,228,.75);
  display:flex;align-items:center;gap:7px;margin-bottom:12px;
}
.cp-profile-head .cp-meta .cp-dot{opacity:.5;}
.cp-status-pill{
  position:relative;display:inline-flex;align-items:center;gap:6px;
  font-size:11px;font-weight:500;padding:5px 11px;border-radius:100px;
  background:rgba(244,240,228,.16);color:var(--cream);
  border:1px solid rgba(244,240,228,.2);
}
.cp-status-dot{width:6px;height:6px;border-radius:50%;background:#8FE3C8;box-shadow:0 0 0 3px rgba(143,227,200,.22);flex:none;}

.cp-info-list{padding:6px 4px;}
.cp-info-row{
  display:flex;align-items:center;gap:10px;padding:11px 16px;font-size:13px;
  border-bottom:1px solid var(--line-soft);cursor:default;background:none;border-left:none;border-right:none;border-top:none;
  width:100%;text-align:left;font-family:inherit;color:var(--ink);
}
.cp-info-row:last-child{border-bottom:none;}
.cp-info-row svg{width:14px;height:14px;color:var(--muted);flex:none;}
.cp-info-row .cp-txt{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1;}
.cp-info-row .cp-txt .cp-l{font-size:10.5px;color:var(--muted);}
.cp-info-row .cp-txt .cp-v{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.cp-info-row.cp-clickable{cursor:pointer;transition:background .15s ease;}
.cp-info-row.cp-clickable:hover{background:var(--teal-bg);}
.cp-info-row .cp-copied-flag{font-size:10.5px;color:var(--teal);display:none;margin-left:auto;flex:none;}
.cp-info-row.cp-copied-state .cp-copied-flag{display:inline;}

.cp-panel-title{font-size:11px;color:var(--muted);padding:14px 16px 4px;}
.cp-fact-row{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:9px 16px;font-size:12.5px;}
.cp-fact-row .cp-l{color:var(--muted);flex:none;}
.cp-fact-row .cp-v{font-weight:500;text-align:right;overflow:hidden;text-overflow:ellipsis;}
.cp-rotate-btn{
  margin:12px 16px 16px;width:calc(100% - 32px);
  font-size:12px;font-weight:500;color:var(--ink);
  background:transparent;border:1px solid var(--line);border-radius:8px;
  padding:9px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;
}
.cp-rotate-btn svg{width:12px;height:12px;}
.cp-rotate-btn:hover:not(:disabled){border-color:var(--ink);background:var(--cream);}
.cp-rotate-btn:disabled{opacity:.6;cursor:default;}
.cp-spin{animation:cpSpin 1s linear infinite;}
@keyframes cpSpin{to{transform:rotate(360deg);}}
.cp-portal-err{margin:0 16px 12px;font-size:11px;color:var(--red);line-height:1.5;}

.cp-quick-grid{display:grid;grid-template-columns:1fr 1fr;}
.cp-quick-grid button{
  background:var(--card);border:none;
  border-right:1px solid var(--line-soft);border-top:1px solid var(--line-soft);
  padding:14px 6px;font-size:11.5px;font-weight:500;color:var(--ink);
  cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:7px;
  transition:background .15s ease,color .15s ease;
}
.cp-quick-grid button:nth-child(2n){border-right:none;}
.cp-quick-grid button:hover{background:var(--teal-bg);color:var(--teal);}
.cp-quick-grid svg{width:16px;height:16px;}

/* ============ main column ============ */
.cp-main{display:flex;flex-direction:column;gap:20px;min-width:0;}
.cp-stat-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;}
.cp-stat-card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;min-width:0;}
.cp-stat-card .cp-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;}
.cp-stat-card .cp-label{font-size:11px;color:var(--muted);}
.cp-stat-card .cp-icon{width:14px;height:14px;color:var(--muted);opacity:.7;}
.cp-stat-card .cp-amount{font-family:'Fraunces',serif;font-weight:600;font-size:21px;line-height:1.1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.cp-stat-card .cp-amount .cp-code{font-family:'Space Grotesk',sans-serif;font-size:11px;font-weight:500;color:var(--muted);margin-right:3px;}
.cp-stat-card.cp-due .cp-amount{color:var(--red);}
.cp-stat-card.cp-due .cp-amount .cp-code{color:var(--red);}
.cp-stat-card.cp-wallet .cp-amount{color:var(--green);}
.cp-stat-card.cp-wallet .cp-amount .cp-code{color:var(--green);}
.cp-stat-card .cp-delta{font-size:11px;color:var(--muted);margin-top:6px;}
.cp-stat-card .cp-delta.cp-up{color:var(--red);}
.cp-stat-card .cp-delta.cp-down{color:var(--teal);}
.cp-stat-card.cp-wallet .cp-delta{color:var(--green);}
.cp-stat-card.cp-due .cp-delta{color:var(--red);}
.cp-stat-card.cp-due.cp-paid .cp-amount{color:var(--green);}
.cp-stat-card.cp-due.cp-paid .cp-delta{color:var(--green);}

/* ============ tabs ============ */
.cp-tabs{
  display:flex;gap:2px;border-bottom:1px solid var(--line);
  padding:0 4px;overflow-x:auto;scrollbar-width:none;
}
.cp-tabs::-webkit-scrollbar{display:none;}
.cp-tab{
  display:flex;align-items:center;gap:7px;background:none;border:none;
  padding:11px 15px;font-size:13px;font-weight:500;color:var(--muted);
  cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;
  transition:color .15s ease;white-space:nowrap;flex:none;
}
.cp-tab svg{width:14px;height:14px;opacity:.75;}
.cp-tab:hover{color:var(--ink);}
.cp-tab.cp-active{color:var(--ink);border-bottom-color:var(--teal);}
.cp-tab.cp-active svg{opacity:1;}

.cp-card-block{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden;}
.cp-card-block-head{
  display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding:16px 20px;border-bottom:1px solid var(--line-soft);flex-wrap:wrap;
}
.cp-card-block-head h3{font-family:'Fraunces',serif;font-weight:600;font-size:15px;margin:0;}
.cp-card-block-head .cp-note{font-size:12px;color:var(--muted);}
.cp-card-block-head .cp-head-actions{display:flex;gap:8px;flex-wrap:wrap;}
.cp-mini-btn{
  font-size:12px;font-weight:500;padding:7px 12px;border-radius:7px;cursor:pointer;
  display:inline-flex;align-items:center;gap:6px;
  background:transparent;color:var(--ink);border:1px solid var(--line);
}
.cp-mini-btn svg{width:12px;height:12px;}
.cp-mini-btn:hover{border-color:var(--ink);background:var(--cream);}

/* balance trend */
.cp-trend{padding:20px 20px 6px;}
.cp-trend-bars{display:flex;align-items:flex-end;gap:10px;height:120px;}
.cp-trend-bar-wrap{flex:1;display:flex;flex-direction:column;align-items:center;gap:8px;height:100%;justify-content:flex-end;min-width:0;}
.cp-trend-bar{width:100%;border-radius:5px 5px 2px 2px;background:var(--teal-bg);position:relative;min-height:6px;}
.cp-trend-bar.cp-paid{background:var(--teal-bg);}
.cp-trend-bar.cp-paid::after{content:"";position:absolute;bottom:0;left:0;right:0;background:var(--teal);border-radius:5px 5px 2px 2px;height:100%;opacity:.85;}
.cp-trend-bar.cp-due{background:var(--amber-bg);}
.cp-trend-bar.cp-due::after{content:"";position:absolute;bottom:0;left:0;right:0;background:var(--amber);border-radius:5px 5px 2px 2px;height:100%;}
.cp-trend-label{font-size:10.5px;color:var(--muted);}
.cp-trend-legend{display:flex;gap:16px;padding:14px 0 18px;font-size:11.5px;color:var(--muted);flex-wrap:wrap;}
.cp-trend-legend span{display:flex;align-items:center;gap:6px;}
.cp-swatch{width:8px;height:8px;border-radius:2px;flex:none;}

/* timeline */
.cp-timeline{padding:6px 0;}
.cp-t-row{display:flex;gap:14px;padding:14px 20px;border-bottom:1px solid var(--line-soft);}
.cp-t-row:last-child{border-bottom:none;}
.cp-t-icon{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex:none;}
.cp-t-icon svg{width:13px;height:13px;}
.cp-t-icon.cp-pay{background:var(--teal-bg);color:var(--teal);}
.cp-t-icon.cp-inv{background:var(--amber-bg);color:var(--amber);}
.cp-t-icon.cp-sys{background:var(--line-soft);color:var(--muted);}
.cp-t-content{flex:1;min-width:0;}
.cp-t-title{font-size:13px;font-weight:500;}
.cp-t-desc{font-size:12px;color:var(--muted);margin-top:2px;overflow:hidden;text-overflow:ellipsis;}
.cp-t-time{font-size:11px;color:var(--muted);flex:none;white-space:nowrap;}

/* tables */
.cp-table-scroll{overflow-x:auto;}
.cp-table-scroll table{width:100%;border-collapse:collapse;font-size:13px;min-width:620px;}
.cp-table-scroll thead th{
  text-align:left;font-weight:500;color:var(--muted);font-size:11px;
  padding:10px 20px;border-bottom:1px solid var(--line-soft);white-space:nowrap;
}
.cp-table-scroll tbody td{padding:12px 20px;border-bottom:1px solid var(--line-soft);vertical-align:middle;}
.cp-table-scroll tbody tr:last-child td{border-bottom:none;}
.cp-table-scroll tbody tr:hover{background:var(--cream);}
.cp-num{font-weight:500;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;}
.cp-pill{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:500;padding:4px 9px;border-radius:100px;white-space:nowrap;}
.cp-pill.cp-paid{background:var(--teal-bg);color:var(--teal);}
.cp-pill.cp-pending{background:var(--amber-bg);color:var(--amber);}
.cp-pill.cp-overdue{background:var(--red-bg);color:var(--red);}
.cp-pill.cp-deposit{background:var(--teal-bg);color:var(--teal);}
.cp-pill.cp-deduction{background:var(--red-bg);color:var(--red);}
.cp-pill .cp-d{width:5px;height:5px;border-radius:50%;background:currentColor;flex:none;}
.cp-dr{color:var(--red);}
.cp-cr{color:var(--teal);}
.cp-mono-small{font-size:11px;color:var(--muted);}

/* accounting */
.cp-account-pills{display:flex;gap:8px;padding:16px 20px 4px;flex-wrap:wrap;}
.cp-account-pill{
  font-size:12px;font-weight:500;padding:6px 12px;border-radius:100px;
  border:1px solid var(--line);color:var(--muted);cursor:pointer;background:transparent;
  transition:border-color .15s ease,color .15s ease,background .15s ease;
}
.cp-account-pill:hover{border-color:var(--ink);color:var(--ink);}
.cp-account-pill.cp-active{background:var(--teal-deep);border-color:var(--teal-deep);color:var(--cream);}
.cp-ledger-summary{
  display:grid;grid-template-columns:repeat(3,1fr);gap:1px;
  background:var(--line-soft);margin:16px 20px;border:1px solid var(--line-soft);border-radius:10px;overflow:hidden;
}
.cp-ledger-summary .cp-cell{background:var(--card);padding:13px 16px;min-width:0;}
.cp-ledger-summary .cp-cell .cp-l{font-size:10.5px;color:var(--muted);margin-bottom:4px;}
.cp-ledger-summary .cp-cell .cp-v{font-family:'Fraunces',serif;font-weight:600;font-size:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.cp-ledger-summary .cp-cell .cp-v .cp-code{font-family:'Space Grotesk',sans-serif;font-size:10.5px;font-weight:500;color:var(--muted);margin-right:2px;}

/* wallet */
.cp-wallet-hero{
  margin:18px 20px 6px;padding:20px;border-radius:12px;
  background:linear-gradient(155deg, var(--teal-deep), var(--teal) 130%);
  color:var(--cream);position:relative;overflow:hidden;
  display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;
}
.cp-wallet-hero::before{content:"";position:absolute;inset:0;background-image:repeating-linear-gradient(115deg, rgba(255,255,255,.05) 0 2px, transparent 2px 26px);}
.cp-wallet-hero .cp-l{position:relative;font-size:11.5px;color:rgba(244,240,228,.75);margin-bottom:6px;}
.cp-wallet-hero .cp-v{position:relative;font-family:'Fraunces',serif;font-weight:700;font-size:28px;}
.cp-wallet-hero .cp-v .cp-code{font-family:'Space Grotesk',sans-serif;font-size:13px;font-weight:500;color:rgba(244,240,228,.7);margin-right:5px;}
.cp-wallet-hero .cp-top-up{
  position:relative;background:var(--cream);color:var(--teal-deep);
  font-size:13px;font-weight:500;padding:10px 16px;border-radius:8px;border:none;cursor:pointer;
  display:flex;align-items:center;gap:7px;white-space:nowrap;
}
.cp-wallet-hero .cp-top-up:hover{background:#fff;}
.cp-wallet-hero .cp-top-up svg{width:14px;height:14px;}
.cp-wallet-mini{display:flex;gap:22px;position:relative;flex-wrap:wrap;}
.cp-wallet-mini div{display:flex;flex-direction:column;gap:3px;}
.cp-wallet-mini .cp-l{font-size:10.5px;color:rgba(244,240,228,.65);}
.cp-wallet-mini .cp-v{font-size:14px;font-weight:600;font-family:'Space Grotesk',sans-serif;}

/* referrals */
.cp-ref-summary{
  display:grid;grid-template-columns:repeat(4,1fr);gap:1px;
  background:var(--line-soft);margin:18px 20px;border:1px solid var(--line-soft);border-radius:10px;overflow:hidden;
}
.cp-ref-summary .cp-cell{background:var(--card);padding:14px 16px;min-width:0;}
.cp-ref-summary .cp-cell .cp-l{font-size:10.5px;color:var(--muted);margin-bottom:5px;}
.cp-ref-summary .cp-cell .cp-v{font-family:'Fraunces',serif;font-weight:600;font-size:17px;overflow:hidden;text-overflow:ellipsis;}
.cp-ref-summary .cp-cell .cp-v.cp-mono{font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:14px;letter-spacing:.5px;}
.cp-ref-summary .cp-cell .cp-v .cp-code{font-family:'Space Grotesk',sans-serif;font-size:11px;font-weight:500;color:var(--muted);margin-right:2px;}
.cp-ref-list{padding:4px 0;}
.cp-ref-row{display:flex;align-items:center;gap:12px;padding:12px 20px;border-bottom:1px solid var(--line-soft);}
.cp-ref-row:last-child{border-bottom:none;}
.cp-ref-avatar{
  width:32px;height:32px;border-radius:50%;background:var(--teal-bg);color:var(--teal);
  display:flex;align-items:center;justify-content:center;font-weight:600;font-size:12px;flex:none;
  font-family:'Fraunces',serif;
}
.cp-ref-body{flex:1;min-width:0;}
.cp-ref-name{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.cp-ref-sub{font-size:11.5px;color:var(--muted);margin-top:1px;}
.cp-ref-reward{text-align:right;flex:none;}
.cp-ref-reward .cp-amt{font-size:13px;font-weight:600;}
.cp-ref-reward .cp-amt.cp-pos{color:var(--teal);}
.cp-empty{padding:28px 20px;text-align:center;color:var(--muted);font-size:13px;}

/* documents */
.cp-doc-section-title{padding:16px 20px 4px;font-size:11px;color:var(--muted);}
.cp-doc-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;padding:8px 20px 20px;}
.cp-doc-card{
  border:1px solid var(--line-soft);border-radius:10px;padding:14px;
  display:flex;flex-direction:column;gap:10px;cursor:pointer;background:transparent;
  transition:border-color .15s ease,background .15s ease;text-align:left;width:100%;
  font-family:inherit;color:var(--ink);font-size:12.5px;
}
.cp-doc-card:hover{border-color:var(--line);background:var(--cream);}
.cp-doc-icon{width:34px;height:34px;border-radius:8px;display:flex;align-items:center;justify-content:center;flex:none;}
.cp-doc-icon svg{width:16px;height:16px;}
.cp-doc-icon.cp-pdf{background:var(--red-bg);color:var(--red);}
.cp-doc-icon.cp-report{background:var(--teal-bg);color:var(--teal);}
.cp-doc-icon.cp-upload{background:var(--amber-bg);color:var(--amber);}
.cp-doc-name{font-size:12.5px;font-weight:500;line-height:1.3;}
.cp-doc-meta{font-size:11px;color:var(--muted);display:flex;justify-content:space-between;align-items:center;gap:8px;}
.cp-doc-dl{color:var(--muted);display:inline-flex;}
.cp-doc-dl:hover{color:var(--ink);}
.cp-doc-dl svg{width:13px;height:13px;}

/* statement modal */
.cp-modal-overlay{
  position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;
  padding:16px;background:rgba(28,35,33,.45);
  backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);
}
.cp-modal-card{
  background:var(--card);border-radius:14px;
  box-shadow:0 25px 60px -12px rgba(0,0,0,.4);
  width:100%;max-width:1100px;height:88vh;max-height:88vh;
  display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--line);
}
.cp-modal-head{
  padding:14px 22px;border-bottom:1px solid var(--line);
  display:flex;align-items:center;justify-content:space-between;background:var(--cream);gap:12px;
}
.cp-modal-head h3{margin:0;font-weight:600;font-size:15px;display:flex;align-items:center;gap:8px;font-family:'Fraunces',serif;}
.cp-modal-head h3 svg{width:17px;height:17px;color:var(--teal);}
.cp-modal-x{
  width:30px;height:30px;border-radius:8px;border:1px solid var(--line);
  background:var(--card);color:var(--muted);display:flex;align-items:center;justify-content:center;cursor:pointer;flex:none;
}
.cp-modal-x:hover{color:var(--ink);border-color:var(--ink);}
.cp-modal-body{flex:1;background:var(--paper);padding:14px;overflow:hidden;min-height:0;}
.cp-modal-body iframe{width:100%;height:100%;border-radius:8px;background:#fff;border:1px solid var(--line);}
.cp-modal-foot{
  padding:12px 22px;border-top:1px solid var(--line);background:var(--cream);
  display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;
}
.cp-creds-card{max-width:420px !important;height:auto !important;}
.cp-creds-head{
  position:relative;background:linear-gradient(155deg, var(--teal-deep), var(--teal) 130%);
  padding:20px 22px 18px;color:var(--cream);overflow:hidden;
}
.cp-creds-head::before{content:"";position:absolute;inset:0;background-image:repeating-linear-gradient(115deg, rgba(255,255,255,.05) 0 2px, transparent 2px 26px);}
.cp-creds-head h3{margin:0;font-family:'Fraunces',serif;font-size:17px;font-weight:600;position:relative;}
.cp-creds-head p{margin:4px 0 0;font-size:12px;color:rgba(244,240,228,.75);line-height:1.45;position:relative;}
.cp-creds-body{padding:16px 22px 18px;display:flex;flex-direction:column;gap:8px;}
.cp-cred-row{
  display:flex;align-items:center;justify-content:space-between;gap:10px;
  padding:11px 14px;background:var(--cream);border:1px solid var(--line-soft);border-radius:10px;
}
.cp-cred-row.cp-amber{background:#FBF3E2;border-color:#EAD9B8;}
.cp-cred-label{font-size:10px;font-weight:600;letter-spacing:.06px;text-transform:uppercase;color:var(--muted);margin-bottom:2px;}
.cp-cred-row.cp-amber .cp-cred-label{color:var(--amber);}
.cp-cred-val{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;}
.cp-copy-btn{
  flex:none;width:32px;height:32px;border-radius:8px;border:1px solid var(--line);
  background:var(--card);color:var(--muted);cursor:pointer;
  display:flex;align-items:center;justify-content:center;
}
.cp-copy-btn:hover{color:var(--teal);border-color:var(--teal);}
.cp-copy-btn svg{width:14px;height:14px;}

/* ============ responsive ============ */
@media (max-width:960px){
  .cp-page{grid-template-columns:1fr;padding:16px 16px 40px;}
  .cp-side{position:static;}
  .cp-stat-grid{grid-template-columns:1fr 1fr;}
  .cp-ledger-summary{grid-template-columns:1fr 1fr;}
  .cp-ref-summary{grid-template-columns:1fr 1fr;}
  .cp-doc-grid{grid-template-columns:1fr 1fr;}
}
@media (max-width:640px){
  .cp-topbar{padding:8px 12px;gap:10px;flex-wrap:wrap;}
  .cp-breadcrumb{font-size:12px;}
  .cp-crumb-mid{display:none;}
  .cp-btn{padding:8px 11px;font-size:12px;}
  .cp-btn .cp-btn-label{display:none;}
  .cp-btn .cp-btn-label-always{display:inline;}
  .cp-page{padding:12px 12px 32px;gap:16px;}
  .cp-stat-grid{grid-template-columns:1fr 1fr;gap:10px;}
  .cp-stat-card{padding:13px 14px;}
  .cp-trend-bars{gap:6px;}
  .cp-trend-label{font-size:9.5px;}
  .cp-stat-card .cp-amount{font-size:18px;}
  .cp-ledger-summary{grid-template-columns:1fr;margin:12px 14px;}
  .cp-ref-summary{grid-template-columns:1fr 1fr;margin:12px 14px;}
  .cp-account-pills{padding:12px 14px 2px;}
  .cp-doc-grid{grid-template-columns:1fr;padding:8px 14px 14px;}
  .cp-doc-section-title{padding:12px 14px 2px;}
  .cp-card-block-head{padding:13px 14px;}
  .cp-trend{padding:14px 14px 4px;}
  .cp-t-row{padding:12px 14px;}
  .cp-wallet-hero{margin:12px 14px 4px;padding:16px;}
  .cp-wallet-hero .cp-v{font-size:24px;}
  .cp-profile-head{padding:20px 18px 16px;}
  .cp-modal-card{height:92vh;max-height:92vh;}
}
@media (max-width:420px){
  .cp-ref-summary{grid-template-columns:1fr;}
  .cp-stat-grid{grid-template-columns:1fr;}
}
`;

const fmtMoney = (n: number) =>
  (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const initialsOf = (name: string) =>
  ((name || '?').split(' ').filter(Boolean).slice(0, 2).map(w => w.charAt(0)?.toUpperCase()).join('')) || '?';

export const CustomerWorkspace: React.FC<CustomerWorkspaceProps> = ({ customer, onBack, onEdit }) => {
  const navigate = useNavigate();
  const { invoices, walletTransactions } = useFinance();
  const { refreshAllData } = useData();
  useModuleRefresh(refreshAllData, { interval: REFRESH_INTERVAL });
  const { customers = [], customerPayments = [], updateCustomer } = useSales();
  const { addAuditLog, companyConfig, auditLogs, notify, user } = useAuth() as any;
  const currency = companyConfig?.currencySymbol || currencyService.getCurrency(currencyService.getBaseCurrency())?.symbol || 'MWK ';
  const currencyCode = (customer as any).currency || companyConfig?.currency || 'MWK';

  const customerDisplayName = getCustomerDisplayName({ businessName: customer.businessName, companyName: customer.companyName, legacyCustomerName: customer.name });
  const initials = initialsOf(customerDisplayName);
  // Real segment from the customer record; 'Individual' is the system default (ClientModal)
  const segmentLabel = customer.segment || (customer as any).customerType || 'Individual';

  const [activeTab, setActiveTab] = useState<RefTab>('overview');
  const [activeAccount, setActiveAccount] = useState('Accounts Receivable');
  const [menuOpen, setMenuOpen] = useState(false);
  const [copiedRow, setCopiedRow] = useState<string | null>(null);
  const [portalBusy, setPortalBusy] = useState(false);
  const [portalError, setPortalError] = useState<string | null>(null);
  const [portalCreds, setPortalCreds] = useState<PortalCredentials | null>(null);
  const [copiedCred, setCopiedCred] = useState<'email' | 'password' | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isStatementModalOpen, setIsStatementModalOpen] = useState(false);
  const [statementPdfUrl, setStatementPdfUrl] = useState<string | null>(null);
  const [referrals, setReferrals] = useState<Referral[]>([]);
  const [referralRewards, setReferralRewards] = useState<ReferralReward[]>([]);
  const [docs, setDocs] = useState<CustomerDocument[]>((customer as any).documents || []);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setDocs(((customer as any).documents || []) as CustomerDocument[]);
  }, [customer?.id]);

  useEffect(() => {
    if (!customer?.id) return;
    referralService.getReferralsByReferrer(customer.id).then(setReferrals).catch(() => {});
    referralService.getRewardsByCustomer(customer.id).then(setReferralRewards).catch(() => {});
  }, [customer?.id]);

  const customerInvoices = useMemo(
    () => invoices.filter(inv => inv.customerId === customer.id || (inv as any).customerName === customerDisplayName || (inv as any).customer === customerDisplayName),
    [invoices, customer, customerDisplayName]
  );
  const customerPaymentsList = useMemo(
    () => customerPayments.filter(p => (p as any).customerName === customerDisplayName || (p as any).customerId === customer.id),
    [customerPayments, customer, customerDisplayName]
  );
  const customerLogs = useMemo(
    () => auditLogs.filter(log => (log as any).entityId === customer.id || ((log as any).details && String((log as any).details).includes(customerDisplayName))),
    [auditLogs, customer, customerDisplayName]
  );
  const customerWalletTransactions = useMemo(
    () => (walletTransactions || []).filter(tx => (tx as any).customerId === customer.id),
    [walletTransactions, customer]
  );

  const canonicalLedger = useMemo(
    () => buildLedgerFromRecords({ customerId: customer.id, invoices: customerInvoices as any, payments: customerPaymentsList as any, openingBalance: Number((customer as any).balance || 0) }),
    [customer.id, (customer as any).balance, customerInvoices, customerPaymentsList]
  );

  const kpis = useMemo(() => {
    const includedInvoices = canonicalLedger.transactions.filter(t => t.type === 'invoice' || t.type === 'credit_note');
    const includedPayments = canonicalLedger.transactions.filter(t => t.type === 'payment');
    const totalInvoiced = includedInvoices.reduce((sum, t) => sum + t.debit, 0);
    const totalPaid = includedPayments.reduce((sum, t) => sum + t.credit, 0);
    const overdueBalance = canonicalLedger.transactions
      .filter(t => {
        if (t.type !== 'invoice') return false;
        const inv: any = customerInvoices.find(i => String((i as any).id) === t.id);
        const dueDate = inv?.dueDate || inv?.due_date;
        return dueDate && isAfter(new Date(), parseISO(String(dueDate)));
      })
      .reduce((sum, t) => sum + t.debit, 0);
    const unpaidCount = customerInvoices.filter((inv: any) => (inv.status || '').toLowerCase() !== 'paid').length;
    return {
      balance: canonicalLedger.closingBalance,
      outstandingBalance: canonicalLedger.outstandingBalance,
      totalInvoiced, totalPaid, overdueBalance, unpaidCount,
    };
  }, [canonicalLedger, customerInvoices]);

  const { openingBalance, ledgerEntries } = useMemo(() => {
    const invMeta = new Map(customerInvoices.map((inv: any) => [String(inv.id), inv]));
    const payMeta = new Map(customerPaymentsList.map((p: any) => [String(p.id), p]));
    const entries = canonicalLedger.transactions.map(tx => {
      const meta: any = tx.type === 'payment' ? payMeta.get(tx.id) : invMeta.get(tx.id);
      return {
        date: tx.date || '', id: tx.id,
        memo: meta?.memo || meta?.description || (tx.type === 'payment' ? 'Customer Payment' : 'Invoice'),
        type: tx.type === 'payment' ? 'Payment' : 'Invoice',
        debit: tx.debit, credit: tx.credit, runningBalance: tx.balance,
      };
    });
    return { openingBalance: 0, ledgerEntries: entries };
  }, [canonicalLedger, customerInvoices, customerPaymentsList]);

  const movement = (canonicalLedger.closingBalance || 0) - (openingBalance || 0);
  const wallet = Number((customer as any).walletBalance || 0);
  const owing = (kpis.outstandingBalance || 0) > 0.5;
  const portalActive = Boolean((customer as any).portalUserId) && (customer as any).portalStatus !== 'disabled';
  const portalEmail = (customer as any).portalEmail || customer.email || '';
  const totalDeposited = customerWalletTransactions.filter((t: any) => t.type === 'Deposit').reduce((s: number, t: any) => s + Number(t.amount || 0), 0);
  const totalDeducted = customerWalletTransactions.filter((t: any) => t.type === 'Deduction').reduce((s: number, t: any) => s + Number(t.amount || 0), 0);

  // Avg. days to pay — computed from real payment behaviour:
  // paid invoices use paidAt (or the allocating payment's date); otherwise '—'.
  const { avgPayDays, paidInvoiceCount } = useMemo(() => {
    const days: number[] = [];
    const allocDateByInvoice = new Map<string, number>();
    customerPaymentsList.forEach((p: any) => {
      const ts = +new Date(p.date);
      if (!Number.isFinite(ts)) return;
      (p.allocations || []).forEach((a: any) => {
        if (!a?.invoiceId) return;
        const prev = allocDateByInvoice.get(String(a.invoiceId));
        if (prev == null || ts < prev) allocDateByInvoice.set(String(a.invoiceId), ts);
      });
    });
    customerInvoices.forEach((inv: any) => {
      const isPaid = String(inv.status || '').toLowerCase() === 'paid' || Number(inv.paidAmount || 0) >= Number(inv.totalAmount || 0);
      if (!isPaid) return;
      const invTs = +new Date(inv.date);
      if (!Number.isFinite(invTs)) return;
      const paidTs = +new Date(inv.paidAt || '') ;
      const ts = Number.isFinite(paidTs) ? paidTs : allocDateByInvoice.get(String(inv.id));
      if (ts == null || !Number.isFinite(ts) || ts < invTs) return;
      days.push(Math.round((ts - invTs) / 86400000));
    });
    if (days.length === 0) return { avgPayDays: null as number | null, paidInvoiceCount: 0 };
    return { avgPayDays: Math.round(days.reduce((s, d) => s + d, 0) / days.length), paidInvoiceCount: days.length };
  }, [customerInvoices, customerPaymentsList]);

  // The shareable referral code IS the customer id — this matches the portal,
  // which builds referral links as `#/portal/referrals?ref=<customerId>`
  // (see CustomerReferrals). A stored override wins if one exists.
  const referralCode = (customer as any).referralCode || customer.id;
  const referralLink = typeof window !== 'undefined'
    ? `${window.location.origin}/#/portal/referrals?ref=${encodeURIComponent(customer.id)}`
    : '';
  const [copiedReferral, setCopiedReferral] = useState<'code' | 'link' | null>(null);
  const copyReferral = async (kind: 'code' | 'link') => {
    try {
      await navigator.clipboard.writeText(kind === 'code' ? referralCode : referralLink);
      setCopiedReferral(kind);
      setTimeout(() => setCopiedReferral(null), 1200);
    } catch { /* clipboard unavailable */ }
  };

  // Wallet running balances, reconstructed backwards from the live wallet
  // balance so every row shows a real "balance after".
  const walletRows = useMemo(() => {
    const asc = customerWalletTransactions.slice().sort((a: any, b: any) => +new Date(a.date) - +new Date(b.date));
    const net = asc.reduce((s: number, t: any) => s + (t.type === 'Deposit' ? 1 : -1) * Number(t.amount || 0), 0);
    let running = wallet - net; // implied opening balance before shown history
    return asc.map((tx: any, i: number) => {
      running += (tx.type === 'Deposit' ? 1 : -1) * Number(tx.amount || 0);
      return { tx, after: running, key: `${tx.id || tx.reference || 'tx'}-${i}` };
    }).reverse();
  }, [customerWalletTransactions, wallet]);

  // Referred-account names resolved from the real customer records
  // (Referral.customerId is the referred party; referredById is this customer).
  const customerNameById = useMemo(() => {
    const map = new Map<string, string>();
    (customers || []).forEach((c: any) => {
      const nm = getCustomerDisplayName({ businessName: c.businessName, companyName: c.companyName, legacyCustomerName: c.name });
      map.set(String(c.id), nm || String(c.id));
    });
    return map;
  }, [customers]);
  const rewardByReferralId = useMemo(() => {
    const map = new Map<string, any>();
    referralRewards.forEach((r: any) => { if (r?.referralId && !map.has(String(r.referralId))) map.set(String(r.referralId), r); });
    return map;
  }, [referralRewards]);
  const rewardsEarned = referralRewards.filter(r => r.status === 'paid' || (r as any).status === 'approved').reduce((s, r) => s + Number((r as any).amount || 0), 0);
  const rewardsPending = referralRewards.filter(r => (r as any).status === 'pending').reduce((s, r) => s + Number((r as any).amount || 0), 0);

  const trend = useMemo(() => {
    const months: { label: string; invoiced: number; paid: number }[] = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = subMonths(now, i);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      const label = format(d, 'MMM');
      const invoiced = customerInvoices
        .filter((inv: any) => { try { const dt = parseISO(String(inv.date)); return dt.getFullYear() === d.getFullYear() && dt.getMonth() === d.getMonth(); } catch { return false; } })
        .reduce((s: number, inv: any) => s + Number(inv.totalAmount || 0), 0);
      const paid = customerPaymentsList
        .filter((p: any) => { try { const dt = parseISO(String(p.date)); return dt.getFullYear() === d.getFullYear() && dt.getMonth() === d.getMonth(); } catch { return false; } })
        .reduce((s: number, p: any) => s + Number(p.amount || 0), 0);
      months.push({ label, invoiced, paid, key } as any);
    }
    const max = Math.max(1, ...months.map(m => Math.max(m.invoiced, m.paid)));
    return months.map(m => {
      const top = Math.max(m.invoiced, m.paid);
      const h = Math.max(10, Math.round((top / max) * 100));
      const isDue = m.invoiced > m.paid;
      return { ...m, height: h, isDue };
    });
  }, [customerInvoices, customerPaymentsList]);

  const recentActivity = useMemo(() => {
    const items: { kind: 'inv' | 'pay' | 'sys'; title: string; desc: string; time: string; ts: number }[] = [];
    customerInvoices.slice().sort((a: any, b: any) => +new Date(b.date) - +new Date(a.date)).slice(0, 3).forEach((inv: any) => {
      items.push({
        kind: 'inv', title: `Invoice ${inv.id} raised`,
        desc: `${currencyCode} ${fmtMoney(Number(inv.totalAmount || 0))}${inv.memo ? ` — ${inv.memo}` : ''}`,
        time: safeDate(inv.date), ts: +new Date(inv.date),
      });
    });
    customerPaymentsList.slice().sort((a: any, b: any) => +new Date(b.date) - +new Date(a.date)).slice(0, 2).forEach((p: any) => {
      items.push({
        kind: 'pay', title: 'Payment received',
        desc: `${currencyCode} ${fmtMoney(Number(p.amount || 0))}${p.paymentMethod ? ` via ${p.paymentMethod}` : ''}`,
        time: safeDate(p.date), ts: +new Date(p.date),
      });
    });
    customerLogs.slice(0, 2).forEach((l: any) => {
      items.push({ kind: 'sys', title: String(l.action || l.details || 'Activity').slice(0, 60), desc: String(l.details || '').slice(0, 90), time: safeDate(l.date), ts: +new Date(l.date) });
    });
    return items.sort((a, b) => b.ts - a.ts).slice(0, 5);
  }, [customerInvoices, customerPaymentsList, customerLogs, currencyCode]);

  const activityFeed = useMemo(() => {
    const items: { kind: 'inv' | 'pay' | 'sys'; title: string; desc: string; time: string; ts: number }[] = [];
    customerInvoices.forEach((inv: any) => items.push({
      kind: 'inv', title: `Invoice ${inv.id} raised`,
      desc: `${currencyCode} ${fmtMoney(Number(inv.totalAmount || 0))} — ${inv.status || 'Unpaid'}`,
      time: safeDate(inv.date), ts: +new Date(inv.date),
    }));
    customerPaymentsList.forEach((p: any) => items.push({
      kind: 'pay', title: 'Payment received',
      desc: `${currencyCode} ${fmtMoney(Number(p.amount || 0))}${p.paymentMethod ? ` via ${p.paymentMethod}` : ''}`,
      time: safeDate(p.date), ts: +new Date(p.date),
    }));
    customerLogs.forEach((l: any) => items.push({
      kind: 'sys', title: String(l.action || 'System event'), desc: String(l.details || '').slice(0, 120),
      time: safeDate(l.date), ts: +new Date(l.date),
    }));
    return items.sort((a, b) => b.ts - a.ts).slice(0, 30);
  }, [customerInvoices, customerPaymentsList, customerLogs, currencyCode]);

  function safeDate(d: any) {
    try { return format(parseISO(String(d)), 'd MMM'); } catch { return '—'; }
  }

  const copyRow = async (key: string, text: string) => {
    try { await navigator.clipboard.writeText(text); } catch { /* noop */ }
    setCopiedRow(key);
    setTimeout(() => setCopiedRow(null), 1200);
  };

  const handleRegeneratePassword = async () => {
    const portalUserId = (customer as any).portalUserId;
    if (portalBusy || !portalUserId) {
      if (!portalUserId) {
        // create instead
        setPortalBusy(true); setPortalError(null);
        try {
          const result = await adminLifecycle.users.autoCreate({
            customer_id: customer.id, name: customerDisplayName, email: customer.email, phone: customer.phone,
          });
          if (result?.user) {
            if (result.generated_password) setPortalCreds({ email: result.user.email, password: result.generated_password });
            updateCustomer({ ...customer, portalUserId: result.user.id, portalEmail: result.user.email, portalStatus: result.user.status || 'active' } as any).catch(() => {});
          }
        } catch (err: any) {
          setPortalError(err?.body?.error || err?.message || 'Failed to create portal account');
        } finally { setPortalBusy(false); }
      }
      return;
    }
    setPortalBusy(true); setPortalError(null);
    try {
      const result = await adminLifecycle.users.regeneratePassword(portalUserId, {
        customer_id: customer.id, name: customerDisplayName, email: customer.email, phone: customer.phone,
      });
      setPortalCreds({ email: portalEmail, password: result.generated_password });
    } catch (err: any) {
      setPortalError(err?.body?.error || err?.message || 'Failed to rotate password');
    } finally { setPortalBusy(false); }
  };

  const copyCred = async (field: 'email' | 'password') => {
    if (!portalCreds) return;
    try { await navigator.clipboard.writeText(portalCreds[field]); setCopiedCred(field); setTimeout(() => setCopiedCred(null), 1500); } catch { /* noop */ }
  };

  const toggleCreditHold = async () => {
    try {
      const newVal = !(customer as any).creditHold;
      await updateCustomer({ ...customer, creditHold: newVal } as any);
      await addAuditLog({ action: (newVal ? 'HOLD' : 'RELEASE') as any, entityType: 'Customer' as any, entityId: customer.id, details: `Credit hold ${newVal ? 'placed' : 'released'} by user` } as any);
      notify(`Credit ${newVal ? 'hold placed' : 'hold released'} for ${customerDisplayName}`, 'success');
      setMenuOpen(false);
    } catch (err: any) {
      notify(`Failed to update credit hold: ${err?.message || err}`, 'error');
    }
  };

  const handleExportLedger = () => {
    const headers = ['Date', 'Reference', 'Description', 'Debit', 'Credit', 'Balance'];
    const rows = ledgerEntries.map(e => [e.date, e.id, `"${(e.memo || '').replace(/"/g, '""')}"`, e.debit || 0, e.credit || 0, e.runningBalance || 0]);
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Ledger_${customerDisplayName}_${format(new Date(), 'yyyy-MM-dd')}.csv`;
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
    setMenuOpen(false);
  };

  const handlePreviewStatement = async () => {
    try {
      const statementData: StatementDoc = {
        date: new Date().toLocaleDateString('en-GB'),
        customerName: customerDisplayName,
        startDate: 'All Time', endDate: 'Present', currency,
        openingBalance,
        transactions: ledgerEntries.map(e => ({
          date: (() => { try { return format(parseISO(e.date), 'dd/MM/yyyy'); } catch { return e.date; } })(),
          reference: e.id, memo: e.memo || (e.type === 'Invoice' ? 'Invoice' : 'Payment'),
          debit: e.debit || 0, credit: e.credit || 0, runningBalance: e.runningBalance,
        })),
        totalInvoiced: ledgerEntries.reduce((s, e) => s + (e.debit || 0), 0),
        totalReceived: ledgerEntries.reduce((s, e) => s + (e.credit || 0), 0),
        finalBalance: ledgerEntries.length > 0 ? ledgerEntries[ledgerEntries.length - 1].runningBalance : openingBalance,
      };
      const secured = await attachDocumentSecurity(statementData, companyConfig?.companyName);
      await initializePrimePdfFonts();
      const blob = await pdf(<PrimeDocument type="ACCOUNT_STATEMENT" data={secured as StatementDoc} />).toBlob();
      setStatementPdfUrl(URL.createObjectURL(blob));
      setIsStatementModalOpen(true);
    } catch (error) {
      logger.error('PDF generation failed:', error);
      alert('Failed to generate statement preview.');
    }
  };

  const handleDocFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setIsUploading(true);
    try {
      let updated: Customer = { ...customer, documents: docs };
      for (const f of Array.from(files)) {
        updated = await customerDocumentsService.upload(updated, f, (user as any)?.name || (user as any)?.email);
      }
      await updateCustomer(updated);
      setDocs(updated.documents || []);
      notify(`${files.length} document${files.length === 1 ? '' : 's'} uploaded`, 'success');
    } catch (err: any) {
      notify(`Upload failed: ${err?.message || err}`, 'error');
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDocDownload = async (doc: CustomerDocument) => {
    try {
      const url = await customerDocumentsService.resolveUrl(doc.fileRef);
      if (!url) { notify('File is not available offline yet', 'error'); return; }
      const a = document.createElement('a');
      a.href = url;
      a.download = doc.fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch {
      notify('Could not download file', 'error');
    }
  };

  const handleDocRemove = async (doc: CustomerDocument) => {
    try {
      const updated = customerDocumentsService.remove({ ...customer, documents: docs }, doc.id);
      await updateCustomer(updated);
      setDocs(updated.documents || []);
      notify('Document removed', 'success');
    } catch (err: any) {
      notify(`Remove failed: ${err?.message || err}`, 'error');
    }
  };

  const [downloadingDoc, setDownloadingDoc] = useState<string | null>(null);

  const downloadInvoicePdf = async (inv: any) => {
    const key = `inv-${inv.id}`;
    if (downloadingDoc) return;
    setDownloadingDoc(key);
    try {
      const config = await hydrateCompanyPdfAssets(getStoredCompanyConfig());
      const enriched = enrichDocumentCustomerData(
        { ...inv, customerName: inv.customerName || customerDisplayName },
        customers as any
      );
      const mapped = mapToInvoiceData(enriched, config, 'INVOICE');
      const secured = await attachDocumentSecurity(mapped, (config as any)?.companyName);
      const blob = await generatePrimeDocumentBlob('INVOICE', secured as PrimeDocData, config);
      downloadBlob(blob, `Invoice - ${inv.invoiceNumber || inv.id}.pdf`);
      notify(`Invoice ${inv.id} downloaded`, 'success');
    } catch (err) {
      logger.error('Invoice PDF download failed:', err);
      notify('Failed to generate invoice PDF', 'error');
    } finally {
      setDownloadingDoc(null);
    }
  };

  const downloadReceiptPdf = async (p: any) => {
    const key = `rcpt-${p.id}`;
    if (downloadingDoc) return;
    setDownloadingDoc(key);
    try {
      const config = await hydrateCompanyPdfAssets(getStoredCompanyConfig());
      const formatted = buildCustomerReceiptDoc({
        payment: p,
        customerName: customerDisplayName,
        currentBalance: kpis.outstandingBalance,
        currencySymbol: currency,
        appliedOrders: (p as any).orderAllocations?.map((a: any) => a.orderId) || [],
      });
      const parsed = ReceiptSchema.safeParse(formatted);
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message || 'Invalid receipt payload');
      const secured = await attachDocumentSecurity(parsed.data, (config as any)?.companyName);
      const blob = await generatePrimeDocumentBlob('RECEIPT', secured as PrimeDocData, config);
      downloadBlob(blob, `Receipt - ${p.id}.pdf`);
      notify(`Receipt ${p.id} downloaded`, 'success');
    } catch (err) {
      logger.error('Receipt PDF download failed:', err);
      notify('Failed to generate receipt PDF', 'error');
    } finally {
      setDownloadingDoc(null);
    }
  };

  const goInvoice = () => { navigate('/sales-flow/invoices', { state: { action: 'create', customer: customer.name, customerId: customer.id } }); setMenuOpen(false); };
  const goQuote = () => { navigate('/sales-flow/orders', { state: { action: 'create', customer: customer.name, customerId: customer.id } }); setMenuOpen(false); };
  const goPayment = () => { navigate('/sales-flow/payments', { state: { action: 'create', customer: customer.name, customerId: customer.id } }); setMenuOpen(false); };
  const goChat = () => { if (customer.phone) window.open(`https://wa.me/${String(customer.phone).replace(/[^0-9]/g, '')}`, '_blank'); };

  const invoiceStatus = (inv: any): 'paid' | 'pending' | 'overdue' => {
    const s = String(inv.status || '').toLowerCase();
    if (s === 'paid' || s === 'cleared') return 'paid';
    const due = inv.dueDate || inv.due_date;
    if (due) { try { if (isAfter(new Date(), parseISO(String(due)))) return 'overdue'; } catch { /* noop */ } }
    if (s === 'overdue') return 'overdue';
    return 'pending';
  };
  const statusLabel = (inv: any) => {
    const k = invoiceStatus(inv);
    return k === 'paid' ? 'Paid' : k === 'overdue' ? 'Overdue' : 'Pending';
  };

  const journalRows = useMemo(() => {
    if (activeAccount === 'Revenue') return ledgerEntries.filter(e => e.type === 'Invoice');
    if (activeAccount === 'Cash / Bank') return ledgerEntries.filter(e => e.type === 'Payment');
    return ledgerEntries;
  }, [ledgerEntries, activeAccount]);

  const tabs: { id: RefTab; label: string; icon: JSX.Element }[] = [
    { id: 'overview', label: 'Overview', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" /></svg> },
    { id: 'invoices', label: 'Invoices', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M6 2h9l5 5v15H6z" /><path d="M15 2v5h5" /><path d="M9 13h6M9 17h6" /></svg> },
    { id: 'payments', label: 'Payments', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="2" y="6" width="20" height="13" rx="2" /><path d="M2 10h20M17 15h.01" /></svg> },
    { id: 'accounting', label: 'Accounting', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 4h16v16H4z" /><path d="M4 10h16M10 4v16" /></svg> },
    { id: 'wallet', label: 'Wallet', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M19 7V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2" /><path d="M18 12h.01" /><path d="M4 8h15a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4" /></svg> },
    { id: 'referrals', label: 'Referrals', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="8" cy="8" r="3.5" /><circle cx="17" cy="15" r="3.5" /><path d="M10.5 9.8 14.5 13" /></svg> },
    { id: 'documents', label: 'Documents', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg> },
    { id: 'activity', label: 'Activity', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg> },
  ];

  const sinceLabel = useMemo(() => {
    const first: any = customerInvoices.slice().sort((a: any, b: any) => +new Date(a.date) - +new Date(b.date))[0];
    if ((customer as any).createdAt) { try { return format(parseISO(String((customer as any).createdAt)), 'd MMM yyyy'); } catch { /* noop */ } }
    if (first?.date) { try { return format(parseISO(String(first.date)), 'd MMM yyyy'); } catch { /* noop */ } }
    return '—';
  }, [customerInvoices, customer]);

  return (
    <div className="cp-root">
      <style>{PROFILE_CSS}</style>

      <div className="cp-topbar">
        <div className="cp-breadcrumb">
          <button className="cp-crumb-btn" onClick={onBack}>Customers</button>
          <span className="cp-sep">/</span>
          <span className="cp-crumb-mid" style={{ whiteSpace: 'nowrap' }}>{segmentLabel}</span>
          <span className="cp-sep cp-crumb-mid">/</span>
          <span className="cp-current">{customerDisplayName}</span>
        </div>
        <div className="cp-topbar-actions">
          <button className="cp-btn cp-btn-secondary" onClick={() => onEdit(customer)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
            <span className="cp-btn-label-always">Edit details</span>
          </button>
          <button className="cp-btn cp-btn-primary" onClick={goInvoice}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 5v14M5 12h14" /></svg>
            <span className="cp-btn-label-always">New invoice</span>
          </button>
          <div className="cp-kebab-wrap">
            <button className="cp-btn cp-btn-ghost" aria-label="More actions" onClick={() => setMenuOpen(v => !v)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" /></svg>
            </button>
            {menuOpen && (
              <div className="cp-kebab-menu" onClick={e => e.stopPropagation()}>
                <button onClick={goPayment}><Plus size={14} /> New payment</button>
                <button onClick={goQuote}><Pencil size={14} /> New quotation</button>
                <button onClick={() => { handlePreviewStatement(); setMenuOpen(false); }}><FileDown size={14} /> PDF statement</button>
                <button onClick={handleExportLedger}><Download size={14} /> Export ledger (CSV)</button>
                <div className="cp-sep" />
                <button onClick={toggleCreditHold}><ShieldAlert size={14} /> {(customer as any).creditHold ? 'Release credit hold' : 'Place credit hold'}</button>
                <button onClick={() => { setMenuOpen(false); onBack(); }}><X size={14} /> Back to customers</button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="cp-page">
        {/* ============ LEFT SIDEBAR ============ */}
        <div className="cp-side">
          <div className="cp-panel">
            <div className="cp-profile-head">
              <div className="cp-avatar-lg">{initials}</div>
              <h1 title={customerDisplayName}>{customerDisplayName}</h1>
              <div className="cp-meta"><span>{customer.id}</span><span className="cp-dot">·</span><span>{segmentLabel}</span></div>
              <span className="cp-status-pill"><span className="cp-status-dot" />{(customer as any).status || 'Active'}</span>
            </div>

            <div className="cp-info-list">
              {customer.phone && (
                <button className={`cp-info-row cp-clickable${copiedRow === 'phone' ? ' cp-copied-state' : ''}`} onClick={() => copyRow('phone', String(customer.phone))}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.86.34 1.7.65 2.5a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.58-1.22a2 2 0 0 1 2.11-.45c.8.31 1.64.53 2.5.65A2 2 0 0 1 22 16.92z" /></svg>
                  <span className="cp-txt"><span className="cp-l">Phone</span><span className="cp-v">{customer.phone}</span></span>
                  <span className="cp-copied-flag">Copied</span>
                </button>
              )}
              {customer.email && (
                <button className={`cp-info-row cp-clickable${copiedRow === 'email' ? ' cp-copied-state' : ''}`} onClick={() => copyRow('email', String(customer.email))}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></svg>
                  <span className="cp-txt"><span className="cp-l">Email</span><span className="cp-v">{customer.email}</span></span>
                  <span className="cp-copied-flag">Copied</span>
                </button>
              )}
              {(customer.address || (customer as any).city) && (
                <div className="cp-info-row">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 21s-7-6.1-9.3-10.2A5.5 5.5 0 0 1 12 4.6a5.5 5.5 0 0 1 9.3 6.2C19 14.9 12 21 12 21z" /></svg>
                  <span className="cp-txt"><span className="cp-l">Zone</span><span className="cp-v">{customer.address}{(customer as any).city ? ` · ${(customer as any).city}` : ''}</span></span>
                </div>
              )}
              <div className="cp-info-row">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="11" width="18" height="10" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
                <span className="cp-txt"><span className="cp-l">Customer portal</span><span className="cp-v">{portalActive ? (portalEmail || 'Active') : 'No account'}</span></span>
              </div>
            </div>
            <button className="cp-rotate-btn" onClick={handleRegeneratePassword} disabled={portalBusy}>
              {portalBusy
                ? <RefreshCw size={12} className="cp-spin" />
                : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>}
              {portalActive ? 'Rotate portal password' : 'Create portal account'}
            </button>
            {portalError && <p className="cp-portal-err">{portalError}</p>}
          </div>

          <div className="cp-panel">
            <div className="cp-panel-title">Account details</div>
            <div className="cp-fact-row"><span className="cp-l">Customer since</span><span className="cp-v">{sinceLabel}</span></div>
            <div className="cp-fact-row"><span className="cp-l">Payment terms</span><span className="cp-v">{(customer as any).paymentTerms || 'Net 30'}</span></div>
            <div className="cp-fact-row"><span className="cp-l">Billing cycle</span><span className="cp-v">{(customer as any).billingCycle || '—'}</span></div>
            <div className="cp-fact-row"><span className="cp-l">Zone agent</span><span className="cp-v">{(customer as any).assignedSalesperson || 'Unassigned'}</span></div>
            <div style={{ height: 12 }} />
          </div>

          <div className="cp-panel">
            <div className="cp-panel-title">Quick actions</div>
            <div className="cp-quick-grid">
              <button onClick={goInvoice}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M6 2h9l5 5v15H6z" /><path d="M15 2v5h5" /><path d="M9 13h6M9 17h6" /></svg>
                Invoice
              </button>
              <button onClick={goQuote}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M6 2h9l5 5v15H6z" /><path d="M15 2v5h5" /><path d="M9 12h6M9 16h4" /></svg>
                Quote
              </button>
              <button onClick={handlePreviewStatement}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="4" y="3" width="16" height="18" rx="1" /><path d="M8 8h8M8 12h8M8 16h5" /></svg>
                Statement
              </button>
              <button onClick={goChat}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-4-1L3 20l1-4.5A8.38 8.38 0 0 1 11.5 3 8.5 8.5 0 0 1 21 11.5z" /></svg>
                Chat
              </button>
            </div>
          </div>
        </div>

        {/* ============ MAIN CONTENT ============ */}
        <div className="cp-main">
          <div className="cp-stat-grid">
            <div className={`cp-stat-card cp-due${owing ? '' : ' cp-paid'}`}>
              <div className="cp-top"><span className="cp-label">Outstanding</span>
                <svg className="cp-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 8v8M9 12h6" /><circle cx="12" cy="12" r="9" /></svg>
              </div>
              <div className="cp-amount"><span className="cp-code">{currencyCode}</span>{fmtMoney(kpis.outstandingBalance)}</div>
              <div className={`cp-delta${owing ? ' cp-up' : ' cp-down'}`}>{owing ? `↑ ${kpis.unpaidCount} invoice${kpis.unpaidCount === 1 ? '' : 's'} unpaid` : 'Fully paid'}</div>
            </div>
            <div className="cp-stat-card cp-wallet">
              <div className="cp-top"><span className="cp-label">Wallet</span>
                <svg className="cp-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="2" y="6" width="20" height="13" rx="2" /><path d="M2 10h20M17 15h.01" /></svg>
              </div>
              <div className="cp-amount"><span className="cp-code">{currencyCode}</span>{fmtMoney(wallet)}</div>
              <div className="cp-delta">Available credit</div>
            </div>
            <div className="cp-stat-card">
              <div className="cp-top"><span className="cp-label">Total invoiced</span>
                <svg className="cp-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 3v18h18" /><path d="m7 14 4-4 3 3 5-6" /></svg>
              </div>
              <div className="cp-amount"><span className="cp-code">{currencyCode}</span>{fmtMoney(kpis.totalInvoiced)}</div>
              <div className="cp-delta">Since {sinceLabel}</div>
            </div>
            <div className="cp-stat-card">
              <div className="cp-top"><span className="cp-label">Avg. days to pay</span>
                <svg className="cp-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" /></svg>
              </div>
              <div className="cp-amount">{avgPayDays == null ? '—' : avgPayDays}</div>
              <div className="cp-delta cp-down">
                {paidInvoiceCount > 0
                  ? `From ${paidInvoiceCount} paid invoice${paidInvoiceCount === 1 ? '' : 's'}`
                  : 'No paid invoices yet'}
              </div>
            </div>
          </div>

          <div className="cp-card-block">
            <div className="cp-tabs" role="tablist">
              {tabs.map(t => (
                <button
                  key={t.id} role="tab" aria-selected={activeTab === t.id}
                  className={`cp-tab${activeTab === t.id ? ' cp-active' : ''}`}
                  onClick={() => setActiveTab(t.id)}
                >
                  {t.icon}{t.label}
                </button>
              ))}
            </div>

            {activeTab === 'overview' && (
              <div>
                <div className="cp-trend">
                  <div className="cp-trend-bars">
                    {trend.map((m: any) => (
                      <div key={m.key} className="cp-trend-bar-wrap">
                        <div className={`cp-trend-bar${m.isDue ? ' cp-due' : ' cp-paid'}`} style={{ height: `${m.height}%` }} title={`${m.label}: inv ${fmtMoney(m.invoiced)}, paid ${fmtMoney(m.paid)}`} />
                        <span className="cp-trend-label">{m.label}</span>
                      </div>
                    ))}
                  </div>
                  <div className="cp-trend-legend">
                    <span><span className="cp-swatch" style={{ background: 'var(--teal)' }} />Paid on time</span>
                    <span><span className="cp-swatch" style={{ background: 'var(--amber)' }} />Outstanding</span>
                  </div>
                </div>
                <div className="cp-card-block-head"><h3>Recent activity</h3><span className="cp-note">Last 30 days</span></div>
                <div className="cp-timeline">
                  {recentActivity.length === 0 && <div className="cp-empty">No recent activity.</div>}
                  {recentActivity.map((a, i) => (
                    <div key={i} className="cp-t-row">
                      <div className={`cp-t-icon${a.kind === 'pay' ? ' cp-pay' : a.kind === 'inv' ? ' cp-inv' : ' cp-sys'}`}>
                        {a.kind === 'pay'
                          ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 6 9 17l-5-5" /></svg>
                          : a.kind === 'inv'
                            ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 2h9l5 5v15H6z" /><path d="M15 2v5h5" /></svg>
                            : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>}
                      </div>
                      <div className="cp-t-content"><div className="cp-t-title">{a.title}</div><div className="cp-t-desc">{a.desc}</div></div>
                      <div className="cp-t-time">{a.time}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {activeTab === 'invoices' && (
              <div className="cp-table-scroll">
                <table>
                  <thead><tr><th>Invoice</th><th>Date</th><th>Description</th><th style={{ textAlign: 'right' }}>Amount</th><th>Status</th></tr></thead>
                  <tbody>
                    {customerInvoices.length === 0 && <tr><td colSpan={5}><div className="cp-empty">No invoices for this customer.</div></td></tr>}
                    {customerInvoices.slice().sort((a: any, b: any) => +new Date(b.date) - +new Date(a.date)).map((inv: any) => {
                      const k = invoiceStatus(inv);
                      return (
                        <tr key={inv.id}>
                          <td style={{ fontWeight: 600 }}>{inv.id}</td>
                          <td>{safeDate(inv.date)} {new Date(inv.date).getFullYear() || ''}</td>
                          <td style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{inv.memo || inv.description || '—'}</td>
                          <td className="cp-num">{fmtMoney(Number(inv.totalAmount || 0))}</td>
                          <td><span className={`cp-pill cp-${k}`}><span className="cp-d" />{statusLabel(inv)}</span></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {activeTab === 'payments' && (
              <div className="cp-table-scroll">
                <table>
                  <thead><tr><th>Reference</th><th>Date</th><th>Method</th><th style={{ textAlign: 'right' }}>Amount</th><th>Applied to</th></tr></thead>
                  <tbody>
                    {customerPaymentsList.length === 0 && <tr><td colSpan={5}><div className="cp-empty">No payments recorded.</div></td></tr>}
                    {customerPaymentsList.slice().sort((a: any, b: any) => +new Date(b.date) - +new Date(a.date)).map((p: any) => (
                      <tr key={p.id}>
                        <td style={{ fontWeight: 600 }}>{p.id}</td>
                        <td>{safeDate(p.date)}</td>
                        <td>{p.paymentMethod || p.method || '—'}</td>
                        <td className="cp-num">{fmtMoney(Number(p.amount || 0))}</td>
                        <td>{(p.allocations || []).map((a: any) => a?.invoiceId).filter(Boolean).join(', ') || p.invoiceId || p.reference || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {activeTab === 'accounting' && (
              <div>
                <div className="cp-account-pills">
                  {['Accounts Receivable', 'Revenue', 'Wallet Liability', 'Cash / Bank'].map(a => (
                    <button key={a} className={`cp-account-pill${activeAccount === a ? ' cp-active' : ''}`} onClick={() => setActiveAccount(a)}>{a}</button>
                  ))}
                </div>
                <div className="cp-ledger-summary">
                  <div className="cp-cell"><div className="cp-l">Opening balance</div><div className="cp-v"><span className="cp-code">{currencyCode}</span>{fmtMoney(openingBalance)}</div></div>
                  <div className="cp-cell"><div className="cp-l">Movement this period</div><div className="cp-v"><span className="cp-code">{currencyCode}</span>{fmtMoney(movement)}</div></div>
                  <div className="cp-cell"><div className="cp-l">Closing balance</div><div className="cp-v"><span className="cp-code">{currencyCode}</span>{fmtMoney(canonicalLedger.closingBalance)}</div></div>
                </div>
                <div className="cp-card-block-head">
                  <h3>Journal postings</h3>
                  <span className="cp-note">Account: {activeAccount}</span>
                </div>
                <div className="cp-table-scroll">
                  <table>
                    <thead><tr><th>Date</th><th>Journal</th><th>Description</th><th style={{ textAlign: 'right' }}>Debit</th><th style={{ textAlign: 'right' }}>Credit</th><th style={{ textAlign: 'right' }}>Balance</th></tr></thead>
                    <tbody>
                      {journalRows.length === 0 && <tr><td colSpan={6}><div className="cp-empty">No postings for this account.</div></td></tr>}
                      {journalRows.slice().reverse().slice(0, 60).map((e, i) => (
                        <tr key={`${e.id}-${i}`}>
                          <td>{safeDate(e.date)}</td>
                          <td className="cp-mono-small">{e.id}</td>
                          <td>{e.memo} <span className="cp-mono-small">· {e.type === 'Payment' ? 'Dr Bank / Cr AR' : 'Dr AR / Cr Revenue'}</span></td>
                          <td className="cp-num cp-dr">{e.debit > 0 ? fmtMoney(e.debit) : '—'}</td>
                          <td className="cp-num cp-cr">{e.credit > 0 ? fmtMoney(e.credit) : '—'}</td>
                          <td className="cp-num">{fmtMoney(e.runningBalance)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {activeTab === 'wallet' && (
              <div>
                <div className="cp-wallet-hero">
                  <div>
                    <div className="cp-l">Available balance</div>
                    <div className="cp-v"><span className="cp-code">{currencyCode}</span>{fmtMoney(wallet)}</div>
                  </div>
                  <div className="cp-wallet-mini">
                    <div><span className="cp-l">Total deposited</span><span className="cp-v">{currencyCode} {fmtMoney(totalDeposited)}</span></div>
                    <div><span className="cp-l">Total deducted</span><span className="cp-v">{currencyCode} {fmtMoney(totalDeducted)}</span></div>
                  </div>
                  <button className="cp-top-up" onClick={goPayment}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 5v14M5 12h14" /></svg>
                    Top up wallet
                  </button>
                </div>
                <div className="cp-card-block-head"><h3>Wallet transactions</h3><span className="cp-note">Prepaid deposits &amp; deductions</span></div>
                <div className="cp-table-scroll">
                  <table>
                    <thead><tr><th>Date</th><th>Reference</th><th>Description</th><th>Type</th><th style={{ textAlign: 'right' }}>Amount</th><th style={{ textAlign: 'right' }}>Balance after</th></tr></thead>
                    <tbody>
                      {walletRows.length === 0 && <tr><td colSpan={6}><div className="cp-empty">No wallet transactions.</div></td></tr>}
                      {walletRows.map(({ tx, after, key }: any) => (
                        <tr key={key}>
                          <td>{safeDate(tx.date)}</td>
                          <td className="cp-mono-small">{tx.id || tx.reference || '—'}</td>
                          <td>{tx.description || tx.memo || '—'}</td>
                          <td><span className={`cp-pill ${tx.type === 'Deposit' ? 'cp-deposit' : 'cp-deduction'}`}><span className="cp-d" />{tx.type || '—'}</span></td>
                          <td className={`cp-num ${tx.type === 'Deposit' ? 'cp-cr' : 'cp-dr'}`}>{fmtMoney(Number(tx.amount || 0))}</td>
                          <td className="cp-num">{fmtMoney(after)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {activeTab === 'referrals' && (
              <div>
                <div className="cp-ref-summary">
                  <div className="cp-cell">
                    <div className="cp-l">Referral code</div>
                    <div className="cp-v cp-mono" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{referralCode}</span>
                      <button
                        className="cp-mini-btn" style={{ padding: '4px 8px', fontSize: 11 }}
                        onClick={() => copyReferral('code')} title="Copy referral code"
                      >
                        {copiedReferral === 'code' ? <Check size={12} /> : <Copy size={12} />}
                        {copiedReferral === 'code' ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                  </div>
                  <div className="cp-cell"><div className="cp-l">Schools referred</div><div className="cp-v">{referrals.length}</div></div>
                  <div className="cp-cell"><div className="cp-l">Rewards earned</div><div className="cp-v"><span className="cp-code">{currencyCode}</span>{fmtMoney(rewardsEarned).split('.')[0]}</div></div>
                  <div className="cp-cell"><div className="cp-l">Rewards pending</div><div className="cp-v"><span className="cp-code">{currencyCode}</span>{fmtMoney(rewardsPending).split('.')[0]}</div></div>
                </div>
                <div className="cp-card-block-head">
                  <h3>Referred accounts</h3>
                  <span className="cp-head-actions">
                    <span className="cp-note">{referrals.length} total</span>
                    <button className="cp-mini-btn" onClick={() => copyReferral('link')} title="Copy customer signup link">
                      {copiedReferral === 'link' ? <Check size={12} /> : <Copy size={12} />}
                      {copiedReferral === 'link' ? 'Link copied' : 'Copy signup link'}
                    </button>
                  </span>
                </div>
                <div className="cp-ref-list">
                  {referrals.length === 0 && <div className="cp-empty">No referred accounts yet. Share the signup link above to refer schools.</div>}
                  {referrals.map((r: any) => {
                    const referredName = customerNameById.get(String(r.customerId)) || r.customerId;
                    const reward = rewardByReferralId.get(String(r.id));
                    const rewardLabel = reward
                      ? `+${currencyCode} ${fmtMoney(Number(reward.amount || 0)).split('.')[0]}`
                      : '—';
                    const rewardState = reward ? String(reward.status || 'Pending') : (r.status === 'converted' ? 'Reward pending' : (r.status || 'Pending'));
                    return (
                      <div key={r.id} className="cp-ref-row">
                        <div className="cp-ref-avatar">{initialsOf(referredName)}</div>
                        <div className="cp-ref-body">
                          <div className="cp-ref-name">{referredName}</div>
                          <div className="cp-ref-sub">Joined {safeDate(r.convertedAt || r.date)} · {r.customerId || ''}{r.referralCode ? ` · Code ${r.referralCode}` : ''}</div>
                        </div>
                        <div className="cp-ref-reward">
                          <div className={`cp-amt${reward && (reward.status === 'paid' || reward.status === 'approved') ? ' cp-pos' : ''}`}>{rewardLabel}</div>
                          <div className="cp-ref-sub">{rewardState}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {activeTab === 'documents' && (
              <div>
                <div className="cp-doc-section-title">Generated reports</div>
                <div className="cp-doc-grid">
                  <button className="cp-doc-card" onClick={handlePreviewStatement}>
                    <div className="cp-doc-icon cp-report"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="4" y="3" width="16" height="18" rx="1" /><path d="M8 8h8M8 12h8M8 16h5" /></svg></div>
                    <div className="cp-doc-name">Account statement — {format(new Date(), 'MMM yyyy')}</div>
                    <div className="cp-doc-meta"><span>PDF · preview &amp; download</span><span className="cp-doc-dl"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 3v12m0 0-4-4m4 4 4-4" /><path d="M4 19h16" /></svg></span></div>
                  </button>
                </div>
                <div className="cp-doc-section-title">Invoices · {customerInvoices.length}</div>
                <div className="cp-doc-grid">
                  {customerInvoices.length === 0 && <div className="cp-empty">No invoices for this customer.</div>}
                  {customerInvoices.slice().sort((a: any, b: any) => +new Date(b.date) - +new Date(a.date)).map((inv: any) => {
                    const busy = downloadingDoc === `inv-${inv.id}`;
                    return (
                      <button
                        key={inv.id}
                        className="cp-doc-card"
                        disabled={busy || downloadingDoc != null}
                        onClick={() => downloadInvoicePdf(inv)}
                        title={`Download Invoice ${inv.id} as PDF`}
                      >
                        <div className="cp-doc-icon cp-pdf"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M6 2h9l5 5v15H6z" /><path d="M15 2v5h5" /></svg></div>
                        <div className="cp-doc-name">{busy ? 'Preparing PDF…' : `Invoice ${inv.invoiceNumber || inv.id}`}</div>
                        <div className="cp-doc-meta"><span>{safeDate(inv.date)} · {currencyCode} {fmtMoney(Number(inv.totalAmount || 0))} · {statusLabel(inv)}</span><span className="cp-doc-dl"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 3v12m0 0-4-4m4 4 4-4" /><path d="M4 19h16" /></svg></span></div>
                      </button>
                    );
                  })}
                </div>
                <div className="cp-doc-section-title">Payment receipts · {customerPaymentsList.length}</div>
                <div className="cp-doc-grid">
                  {customerPaymentsList.length === 0 && <div className="cp-empty">No payment receipts for this customer.</div>}
                  {customerPaymentsList.slice().sort((a: any, b: any) => +new Date(b.date) - +new Date(a.date)).map((p: any) => {
                    const busy = downloadingDoc === `rcpt-${p.id}`;
                    return (
                      <button
                        key={p.id}
                        className="cp-doc-card"
                        disabled={busy || downloadingDoc != null}
                        onClick={() => downloadReceiptPdf(p)}
                        title={`Download Receipt ${p.id} as PDF`}
                      >
                        <div className="cp-doc-icon cp-report"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="2" y="6" width="20" height="13" rx="2" /><path d="M2 10h20M17 15h.01" /></svg></div>
                        <div className="cp-doc-name">{busy ? 'Preparing PDF…' : `Receipt ${p.id}`}</div>
                        <div className="cp-doc-meta"><span>{safeDate(p.date)} · {currencyCode} {fmtMoney(Number(p.amount || 0))} · {p.paymentMethod || p.method || 'Payment'}</span><span className="cp-doc-dl"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 3v12m0 0-4-4m4 4 4-4" /><path d="M4 19h16" /></svg></span></div>
                      </button>
                    );
                  })}
                </div>
                <div className="cp-doc-section-title">Uploaded files · {docs.length}</div>
                <div className="cp-doc-grid">
                  <button
                    className="cp-doc-card"
                    disabled={isUploading}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <div className="cp-doc-icon cp-upload"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 16V4m0 0 4 4m-4-4L8 8" /><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></svg></div>
                    <div className="cp-doc-name">{isUploading ? 'Uploading…' : 'Upload a file'}</div>
                    <div className="cp-doc-meta"><span>Contracts, proofs, orders</span></div>
                  </button>
                  {docs.map(doc => (
                    <div key={doc.id} className="cp-doc-card" style={{ cursor: 'default' }}>
                      <div className="cp-doc-icon cp-upload"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg></div>
                      <div className="cp-doc-name" title={doc.fileName}>{doc.fileName}</div>
                      <div className="cp-doc-meta">
                        <span>{doc.mimeType.split('/')[1]?.toUpperCase() || 'FILE'} · {formatCustomerDocSize(doc.size)}</span>
                        <span style={{ display: 'flex', gap: 8 }}>
                          <button
                            className="cp-doc-dl" title="Download" aria-label={`Download ${doc.fileName}`}
                            onClick={() => handleDocDownload(doc)}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 3v12m0 0-4-4m4 4 4-4" /><path d="M4 19h16" /></svg>
                          </button>
                          <button
                            className="cp-doc-dl" title="Remove" aria-label={`Remove ${doc.fileName}`}
                            onClick={() => handleDocRemove(doc)}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-9 0 1 13h8l1-13" /></svg>
                          </button>
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  style={{ display: 'none' }}
                  onChange={e => handleDocFiles(e.target.files)}
                />
              </div>
            )}

            {activeTab === 'activity' && (
              <div className="cp-timeline">
                {activityFeed.length === 0 && <div className="cp-empty">No activity yet.</div>}
                {activityFeed.map((a, i) => (
                  <div key={i} className="cp-t-row">
                    <div className={`cp-t-icon${a.kind === 'pay' ? ' cp-pay' : a.kind === 'inv' ? ' cp-inv' : ' cp-sys'}`}>
                      {a.kind === 'pay'
                        ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 6 9 17l-5-5" /></svg>
                        : a.kind === 'inv'
                          ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 2h9l5 5v15H6z" /><path d="M15 2v5h5" /></svg>
                          : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="10" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>}
                    </div>
                    <div className="cp-t-content"><div className="cp-t-title">{a.title}</div><div className="cp-t-desc">{a.desc}</div></div>
                    <div className="cp-t-time">{a.time}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {isStatementModalOpen && statementPdfUrl && (
        <div className="cp-modal-overlay" onClick={() => setIsStatementModalOpen(false)}>
          <div className="cp-modal-card" onClick={e => e.stopPropagation()}>
            <div className="cp-modal-head">
              <h3><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M6 2h9l5 5v15H6z" /><path d="M15 2v5h5" /></svg>Statement Preview</h3>
              <button className="cp-modal-x" onClick={() => setIsStatementModalOpen(false)}><X size={15} /></button>
            </div>
            <div className="cp-modal-body"><iframe src={statementPdfUrl} title="Statement Preview" /></div>
            <div className="cp-modal-foot">
              <button className="cp-btn cp-btn-secondary" onClick={() => setIsStatementModalOpen(false)}>Close</button>
              <a className="cp-btn cp-btn-primary" href={statementPdfUrl} download={`Statement_${customerDisplayName}_${format(new Date(), 'yyyy-MM-dd')}.pdf`} onClick={e => e.stopPropagation()}>
                <Download size={14} /> Download PDF
              </a>
            </div>
          </div>
        </div>
      )}

      {portalCreds && (
        <div className="cp-modal-overlay" onClick={() => setPortalCreds(null)}>
          <div className="cp-modal-card cp-creds-card" onClick={e => e.stopPropagation()}>
            <div className="cp-creds-head">
              <h3>Portal Credentials</h3>
              <p>Share with the customer. Password is shown only once.</p>
            </div>
            <div className="cp-creds-body">
              <div className="cp-cred-row">
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="cp-cred-label">Portal Email</div>
                  <div className="cp-cred-val">{portalCreds.email}</div>
                </div>
                <button className="cp-copy-btn" onClick={() => copyCred('email')} title="Copy email">
                  {copiedCred === 'email' ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
              <div className="cp-cred-row cp-amber">
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="cp-cred-label">New Password</div>
                  <div className="cp-cred-val">{portalCreds.password}</div>
                </div>
                <button className="cp-copy-btn" onClick={() => copyCred('password')} title="Copy password">
                  {copiedCred === 'password' ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
            </div>
            <div className="cp-modal-foot">
              <button className="cp-btn cp-btn-primary" onClick={() => setPortalCreds(null)}>Done</button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};

export default CustomerWorkspace;
