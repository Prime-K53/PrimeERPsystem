import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { HelpCircle, Plus, Pencil, Trash2, Search, X, ChevronDown, ChevronRight, Eye, EyeOff, Tag } from 'lucide-react';
import { adminLifecycle } from '../../services/adminPortalClient';

interface SupportArticle {
  id: string;
  slug: string;
  title: string;
  summary: string;
  body: string;
  category: string;
  tags: string[];
  helpful?: number;
  not_helpful?: number;
  last_updated?: string;
  updated_at?: string;
  created_at?: string;
  version?: number;
}

const CATEGORIES = ['General', 'Account', 'Orders', 'Payments', 'Products', 'Technical', 'Billing', 'Shipping', 'Returns'];

function emptyForm() {
  return {
    id: '',
    slug: '',
    title: '',
    summary: '',
    body: '',
    category: 'General',
    tags: [] as string[],
  };
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

export const FAQManager: React.FC = () => {
  const [articles, setArticles] = useState<SupportArticle[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [showNew, setShowNew] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm());
  const [tagInput, setTagInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [notify, setNotify] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [expandedCats, setExpandedCats] = useState<Set<string>>(new Set(['General']));

  const notify_ = useCallback((kind: 'success' | 'error', text: string) => {
    setNotify({ kind, text });
    setTimeout(() => setNotify(null), 3000);
  }, []);

  const load = useCallback(async () => {
    try {
      const data = await adminLifecycle.supportArticles.list();
      setArticles(data);
    } catch (err: any) {
      notify_('error', err?.message || 'Failed to load articles');
    } finally {
      setLoading(false);
    }
  }, [notify_]);

  useEffect(() => { load(); }, [load]);

  const openNew = () => {
    setEditingId(null);
    setForm(emptyForm());
    setShowNew(true);
  };

  const openEdit = (a: SupportArticle) => {
    setEditingId(a.id);
    setForm({
      id: a.id,
      slug: a.slug,
      title: a.title,
      summary: a.summary || '',
      body: a.body || '',
      category: a.category || 'General',
      tags: a.tags || [],
    });
    setShowNew(true);
  };

  const closeModal = () => {
    setShowNew(false);
    setEditingId(null);
    setForm(emptyForm());
    setTagInput('');
  };

  const handleTitleChange = (v: string) => {
    setForm((f) => ({ ...f, title: v, slug: editingId ? f.slug : slugify(v) }));
  };

  const addTag = () => {
    const t = tagInput.trim().toLowerCase().replace(/[^a-z0-9\s-]/g, '');
    if (t && !form.tags.includes(t)) {
      setForm((f) => ({ ...f, tags: [...f.tags, t] }));
    }
    setTagInput('');
  };

  const removeTag = (t: string) => {
    setForm((f) => ({ ...f, tags: f.tags.filter((x) => x !== t) }));
  };

  const save = async () => {
    if (!form.title.trim()) { notify_('error', 'Title is required'); return; }
    if (!form.slug.trim()) { notify_('error', 'Slug is required'); return; }
    setSaving(true);
    try {
      if (editingId) {
        await adminLifecycle.supportArticles.update(editingId, form);
        notify_('success', 'Article updated');
      } else {
        await adminLifecycle.supportArticles.create(form as SupportArticle);
        notify_('success', 'Article created');
      }
      closeModal();
      load();
    } catch (err: any) {
      notify_('error', err?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = (a: SupportArticle) => {
    setDeletingId(a.id);
  };

  const doDelete = async () => {
    if (!deletingId) return;
    try {
      await adminLifecycle.supportArticles.remove(deletingId);
      notify_('success', 'Article deleted');
      setDeletingId(null);
      load();
    } catch (err: any) {
      notify_('error', err?.message || 'Delete failed');
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return articles.filter((a) => {
      const matchCat = categoryFilter === 'all' || a.category === categoryFilter;
      if (!matchCat) return false;
      if (!q) return true;
      return (
        a.title.toLowerCase().includes(q) ||
        a.summary.toLowerCase().includes(q) ||
        a.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [articles, search, categoryFilter]);

  const byCategory = useMemo(() => {
    const map: Record<string, SupportArticle[]> = {};
    for (const a of filtered) {
      const cat = a.category || 'General';
      if (!map[cat]) map[cat] = [];
      map[cat].push(a);
    }
    return map;
  }, [filtered]);

  const catCounts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const a of articles) {
      const cat = a.category || 'General';
      map[cat] = (map[cat] || 0) + 1;
    }
    return map;
  }, [articles]);

  const toggleCat = (cat: string) => {
    setExpandedCats((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <HelpCircle size={28} style={{ color: '#6366f1' }} />
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0, color: '#1e293b' }}>FAQ Manager</h1>
            <p style={{ fontSize: 13, color: '#64748b', margin: '4px 0 0' }}>{articles.length} articles across {Object.keys(catCounts).length} categories</p>
          </div>
        </div>
        <button
          onClick={openNew}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 18px', background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
        >
          <Plus size={16} /> New Article
        </button>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: '1 1 260px' }}>
          <Search size={15} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search articles…"
            style={{ width: '100%', padding: '9px 12px 9px 34px', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 14, outline: 'none', boxSizing: 'border-box' }}
          />
        </div>
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          style={{ padding: '9px 12px', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 14, outline: 'none', cursor: 'pointer', minWidth: 150 }}
        >
          <option value="all">All Categories</option>
          {CATEGORIES.filter((c) => catCounts[c]).map((c) => (
            <option key={c} value={c}>{c} ({catCounts[c]})</option>
          ))}
        </select>
      </div>

      {/* Notify toast */}
      {notify && (
        <div style={{
          position: 'fixed', top: 20, right: 20, zIndex: 9999,
          padding: '12px 20px', borderRadius: 8, fontSize: 14, fontWeight: 500,
          background: notify.kind === 'success' ? '#10b981' : '#ef4444',
          color: '#fff', boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        }}>
          {notify.text}
        </div>
      )}

      {/* Loading */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 60, color: '#94a3b8' }}>Loading articles…</div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 60, color: '#94a3b8' }}>
          {search || categoryFilter !== 'all' ? 'No articles match your filters.' : 'No articles yet. Click "New Article" to create one.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {Object.entries(byCategory).map(([cat, arts]) => {
            const expanded = expandedCats.has(cat);
            return (
              <div key={cat} style={{ border: '1px solid #e2e8f0', borderRadius: 12, overflow: 'hidden' }}>
                <button
                  onClick={() => toggleCat(cat)}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', background: '#f8fafc', border: 'none', cursor: 'pointer', textAlign: 'left' }}
                >
                  {expanded ? <ChevronDown size={16} style={{ color: '#64748b' }} /> : <ChevronRight size={16} style={{ color: '#64748b' }} />}
                  <span style={{ fontWeight: 700, fontSize: 14, color: '#334155' }}>{cat}</span>
                  <span style={{ fontSize: 12, color: '#94a3b8', marginLeft: 4 }}>({arts.length})</span>
                </button>
                {expanded && (
                  <div style={{ divide: '1px solid #f1f5f9' }}>
                    {arts.map((a) => (
                      <div key={a.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 16px', borderTop: '1px solid #f1f5f9', background: '#fff' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600, fontSize: 14, color: '#1e293b', marginBottom: 2 }}>{a.title}</div>
                          <div style={{ fontSize: 12, color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.summary}</div>
                          {a.tags.length > 0 && (
                            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
                              {a.tags.map((t) => (
                                <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '2px 8px', background: '#f1f5f9', borderRadius: 12, fontSize: 11, color: '#64748b' }}>
                                  <Tag size={10} />{t}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                          <button onClick={() => openEdit(a)} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 12px', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 12, cursor: 'pointer', color: '#475569' }}>
                            <Pencil size={12} /> Edit
                          </button>
                          <button onClick={() => confirmDelete(a)} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, fontSize: 12, cursor: 'pointer', color: '#dc2626' }}>
                            <Trash2 size={12} /> Delete
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Create / Edit Modal */}
      {showNew && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(15,23,42,0.5)' }} onClick={(e) => e.target === e.currentTarget && closeModal()}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: '100%', maxWidth: 680, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 25px 50px rgba(0,0,0,0.25)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
              <h2 style={{ fontSize: 18, fontWeight: 800, margin: 0 }}>{editingId ? 'Edit Article' : 'New Article'}</h2>
              <button onClick={closeModal} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', display: 'flex', alignItems: 'center' }}><X size={20} /></button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <label style={{ fontSize: 13, fontWeight: 600, color: '#475569', display: 'block', marginBottom: 4 }}>Title *</label>
                <input value={form.title} onChange={(e) => handleTitleChange(e.target.value)} placeholder="e.g. How do I reset my password?" style={{ width: '100%', padding: '9px 12px', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 14, outline: 'none', boxSizing: 'border-box' }} />
              </div>

              <div>
                <label style={{ fontSize: 13, fontWeight: 600, color: '#475569', display: 'block', marginBottom: 4 }}>Slug (URL key)</label>
                <input value={form.slug} onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))} placeholder="auto-generated-from-title" style={{ width: '100%', padding: '9px 12px', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 14, outline: 'none', boxSizing: 'border-box', fontFamily: 'monospace' }} />
              </div>

              <div style={{ display: 'flex', gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: 13, fontWeight: 600, color: '#475569', display: 'block', marginBottom: 4 }}>Category</label>
                  <select value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))} style={{ width: '100%', padding: '9px 12px', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 14, outline: 'none', cursor: 'pointer' }}>
                    {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              </div>

              <div>
                <label style={{ fontSize: 13, fontWeight: 600, color: '#475569', display: 'block', marginBottom: 4 }}>Summary (short description)</label>
                <input value={form.summary} onChange={(e) => setForm((f) => ({ ...f, summary: e.target.value }))} placeholder="One-line description shown in article cards" style={{ width: '100%', padding: '9px 12px', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 14, outline: 'none', boxSizing: 'border-box' }} />
              </div>

              <div>
                <label style={{ fontSize: 13, fontWeight: 600, color: '#475569', display: 'block', marginBottom: 4 }}>Body (HTML allowed)</label>
                <textarea
                  value={form.body}
                  onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
                  placeholder="<p>Full article content…</p>"
                  rows={10}
                  style={{ width: '100%', padding: '9px 12px', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 14, outline: 'none', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'monospace' }}
                />
              </div>

              <div>
                <label style={{ fontSize: 13, fontWeight: 600, color: '#475569', display: 'block', marginBottom: 4 }}>Tags</label>
                <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                  <input
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
                    placeholder="Add a tag and press Enter"
                    style={{ flex: 1, padding: '9px 12px', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 14, outline: 'none', boxSizing: 'border-box' }}
                  />
                  <button type="button" onClick={addTag} style={{ padding: '9px 16px', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 13, cursor: 'pointer' }}>Add</button>
                </div>
                {form.tags.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {form.tags.map((t) => (
                      <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', background: '#eef2ff', border: '1px solid #c7d2fe', borderRadius: 20, fontSize: 12, color: '#4338ca' }}>
                        {t} <X size={11} style={{ cursor: 'pointer' }} onClick={() => removeTag(t)} />
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 24 }}>
              <button onClick={closeModal} style={{ padding: '9px 20px', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 14, cursor: 'pointer' }}>Cancel</button>
              <button onClick={save} disabled={saving} style={{ padding: '9px 20px', background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.6 : 1 }}>
                {saving ? 'Saving…' : editingId ? 'Save Changes' : 'Create Article'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirm Modal */}
      {deletingId && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(15,23,42,0.5)' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: '100%', maxWidth: 420, boxShadow: '0 25px 50px rgba(0,0,0,0.25)' }}>
            <h2 style={{ fontSize: 18, fontWeight: 800, margin: '0 0 12px' }}>Delete Article?</h2>
            <p style={{ fontSize: 14, color: '#64748b', margin: '0 0 24px' }}>This action cannot be undone. The article will be permanently removed from the customer portal.</p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setDeletingId(null)} style={{ padding: '9px 20px', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 14, cursor: 'pointer' }}>Cancel</button>
              <button onClick={doDelete} style={{ padding: '9px 20px', background: '#ef4444', color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default FAQManager;
