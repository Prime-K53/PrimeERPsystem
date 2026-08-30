import { logger } from '@/services/logger';
import { patchStoredCompanyConfig } from '@/utils/companyConfigSync';

export interface AIConfig {
  provider: 'openai' | 'anthropic' | 'ollama' | 'openrouter';
  apiKey: string;
  endpoint: string;
  model: string;
  enabled: boolean;
}

export interface SmartReplySuggestion {
  text: string;
  label: string;
}

export interface GeneratedAdCopy {
  title: string;
  subtitle: string;
  description: string;
  badge: string;
  ctaLabel: string;
  emoji: string;
  gradient: string;
}

const DEFAULT_CONFIG: AIConfig = {
  provider: 'openai',
  apiKey: '',
  endpoint: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  enabled: false,
};

const PROVIDER_DEFAULTS: Record<string, { endpoint: string; model: string }> = {
  openai: { endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  anthropic: { endpoint: 'https://api.anthropic.com/v1', model: 'claude-3-haiku-20240307' },
  ollama: { endpoint: 'http://localhost:11434/v1', model: 'llama3' },
  openrouter: { endpoint: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
};

class AIService {
  private config: AIConfig = DEFAULT_CONFIG;
  private loaded = false;

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = localStorage.getItem('nexus_company_config');
      if (raw) {
        const companyConfig = JSON.parse(raw);
        const aiConfig = companyConfig?.aiConfig;
        if (aiConfig) {
          this.config = {
            provider: aiConfig.provider || DEFAULT_CONFIG.provider,
            apiKey: aiConfig.apiKey || aiConfig.openrouterApiKey || DEFAULT_CONFIG.apiKey,
            endpoint: aiConfig.endpoint || aiConfig.baseUrl || DEFAULT_CONFIG.endpoint,
            model: aiConfig.model || aiConfig.openrouterModel || DEFAULT_CONFIG.model,
            enabled: true,
          };
          this.loaded = true;
          return;
        }
      }
      this.config = { ...DEFAULT_CONFIG };
    } catch {
      this.config = { ...DEFAULT_CONFIG };
    }
    this.loaded = true;
  }

  async getConfig(): Promise<AIConfig> {
    await this.ensureLoaded();
    return { ...this.config };
  }

  async saveConfig(config: Partial<AIConfig>): Promise<void> {
    await this.ensureLoaded();
    const merged = { ...this.config, ...config };
    this.config = { ...merged, enabled: true };
    try {
      const raw = localStorage.getItem('nexus_company_config');
      if (raw) {
        const existing = JSON.parse(raw);
        existing.aiConfig = { ...(existing.aiConfig || {}), ...config, enabled: true };
        localStorage.setItem('nexus_company_config', JSON.stringify(existing));
      }
      // Sync through the authoritative company-config store so the change
      // propagates to every device of the company.
      void patchStoredCompanyConfig({ aiConfig: { ...this.config, enabled: true } } as unknown as Partial<import('../types').CompanyConfig>).catch((e) => {
        logger.error('Failed to sync AI config to company store', e instanceof Error ? e : new Error('Unknown'));
      });
    } catch (e) { logger.error("Operation failed", e as Error); }
  }

  private buildSystemPrompt(context: string): string {
    const prompts: Record<string, string> = {
      smartReply: `You are a professional WhatsApp business assistant for a print shop / ERP system. 
Given the conversation history, suggest 3 concise, helpful reply options for the business owner to send.
Each reply should be: friendly, professional, under 100 characters, and use placeholders like {{name}} where appropriate.
Return exactly 3 suggestions as a JSON array of objects with keys: "text" (the reply message) and "label" (a short label like "Friendly", "Professional", "Short").
Format: [{"label":"...","text":"..."}]`,

      generateTemplate: `You are a WhatsApp marketing template expert for a print shop ERP.
Generate a professional WhatsApp message template based on the user's description.
The template should use placeholders like {{name}}, {{company}}, {{product}}, etc.
Return a JSON object with keys: "name" (short template name), "content" (the message), "category" (one of: Welcome, Promotions, Follow-up, Orders, Billing, Support, General, CTA), and "variables" (array of placeholder names without braces).
Format: {"name":"...","content":"...","category":"...","variables":["name","company"]}`,

      analyzeSentiment: `Analyze the sentiment of this customer message and return a JSON object with keys: "sentiment" (one of: positive, neutral, negative, urgent), "priority" (one of: high, normal, low), "summary" (one sentence describing the message), and "suggestedTags" (array of 1-3 tag strings).
Format: {"sentiment":"...","priority":"...","summary":"...","suggestedTags":["..."]}`,

      generateAdCopy: `You are a senior copywriter for a premium print shop and business services company. Your writing is polished, persuasive, and professional — the kind of copy you'd see in a Fortune 500 marketing campaign or a high-end agency pitch.

Generate a compelling banner ad campaign for their customer portal. Return a JSON object with keys:
- "title": Short, punchy headline (max 6 words) that grabs attention instantly
- "subtitle": One powerful supporting sentence (max 14 words) that reinforces the value proposition
- "description": A rich 2-3 paragraph premium business ad description. Paragraph 1 hooks the reader with a benefit-driven opening. Paragraph 2 expands on the offer with specific details, social proof, or urgency. Paragraph 3 closes with a soft call-to-action tone. Write in an authoritative yet approachable voice — avoid clichés, avoid filler words, avoid "Add". Every word must earn its place.
- "badge": 2-4 word label such as "Limited Time", "New Arrival", "Exclusive Offer", "Members Only"
- "ctaLabel": Short button text (2-4 words) like "Order Now", "Learn More", "Get Started", "Claim Offer"
- "emoji": A single emoji that reinforces the brand feel (professional, not playful)
- "gradient": A CSS linear-gradient using two rich hex colors, e.g. linear-gradient(135deg, #0b3e39 0%, #1f8577 100%)

Format: {"title":"...","subtitle":"...","description":"...","badge":"...","ctaLabel":"...","emoji":"...","gradient":"..."}`,
    };
    return prompts[context] || prompts.smartReply;
  }

  private async callAPI(messages: { role: string; content: string }[]): Promise<string> {
    const { provider, apiKey, endpoint, model } = this.config;

    if (!apiKey && provider !== 'ollama') {
      throw new Error('AI API key not configured. Go to Marketing Messages > AI Settings to configure.');
    }

    let url: string;
    let headers: Record<string, string> = { 'Content-Type': 'application/json' };
    let body: any;

    switch (provider) {
      case 'anthropic': {
        url = `${endpoint}/messages`;
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
        body = {
          model,
          max_tokens: 1024,
          messages: messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
        };
        break;
      }
      case 'openai':
      case 'ollama':
      case 'openrouter':
      default: {
        url = `${endpoint}/chat/completions`;
        headers['Authorization'] = `Bearer ${apiKey}`;
        body = { model, messages, max_tokens: 1024, temperature: 0.7 };
        break;
      }
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => 'Unknown error');
      throw new Error(`AI API error (${response.status}): ${errText}`);
    }

    const data = await response.json();

    if (provider === 'anthropic') {
      return data.content?.[0]?.text || '';
    }
    return data.choices?.[0]?.message?.content || '';
  }

  async generateSmartReplies(chat: { customerName: string; messages: { content: string; direction: string }[] }): Promise<SmartReplySuggestion[]> {
    await this.ensureLoaded();
    if (!this.config.enabled || !this.config.apiKey) {
      return this.fallbackReplies(chat);
    }

    const history = chat.messages.slice(-6).map(m =>
      `${m.direction === 'inbound' ? chat.customerName : 'You'}: ${m.content}`
    ).join('\n');

    try {
      const response = await this.callAPI([
        { role: 'system', content: this.buildSystemPrompt('smartReply') },
        { role: 'user', content: `Conversation with ${chat.customerName}:\n${history}\n\nSuggest 3 replies:` },
      ]);

      const cleaned = response.replace(/```json?/gi, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed) && parsed.length >= 2) {
        return parsed.slice(0, 3).map((s: any) => ({
          text: s.text || s.reply || '',
          label: s.label || 'Reply',
        }));
      }
    } catch {
      // Fallback to template-based suggestions
    }
    return this.fallbackReplies(chat);
  }

  private fallbackReplies(chat: { customerName: string; messages: { content: string; direction: string }[] }): SmartReplySuggestion[] {
    const name = chat.customerName || 'there';
    const lastMsg = chat.messages?.[chat.messages.length - 1]?.content?.toLowerCase() || '';

    if (lastMsg.includes('price') || lastMsg.includes('cost') || lastMsg.includes('how much')) {
      return [
        { label: 'Quote', text: `Thank you for your interest, {{name}}! I'll prepare a price quote for you right away.` },
        { label: 'More Info', text: `Great question {{name}}! Could you tell me more about what you need so I can give you an accurate price?` },
        { label: 'Call', text: `Hi {{name}}, I'd love to discuss pricing in detail. Would you prefer a quick phone call?` },
      ];
    }
    if (lastMsg.includes('hello') || lastMsg.includes('hi') || lastMsg.includes('hey')) {
      return [
        { label: 'Greeting', text: `Hello {{name}}! Welcome to {{company}}. How can I assist you today?` },
        { label: 'Services', text: `Hi {{name}}! We offer printing, binding, and design services. What are you looking for?` },
        { label: 'Help', text: `Hey {{name}}! Great to hear from you. What can we help you with today?` },
      ];
    }
    if (lastMsg.includes('thank')) {
      return [
        { label: 'Welcome', text: `You're welcome {{name}}! Happy to help. Let me know if you need anything else!` },
        { label: 'Feedback', text: `Our pleasure {{name}}! We'd love your feedback on our service.` },
        { label: 'Follow-up', text: `Anytime {{name}}! I'll follow up next week to see how everything is going.` },
      ];
    }
    if (lastMsg.includes('order') || lastMsg.includes('track') || lastMsg.includes('delivery')) {
      return [
        { label: 'Status', text: `Let me check your order status {{name}}. One moment please.` },
        { label: 'Tracking', text: `I'll send you the tracking details for your order right away {{name}}.` },
        { label: 'Support', text: `I've looked up your order {{name}}. Let me give you an update.` },
      ];
    }

    return [
      { label: 'Friendly', text: `Thank you for reaching out {{name}}! How can I assist you today?` },
      { label: 'Professional', text: `Dear {{name}}, thank you for your message. How may I help you?` },
      { label: 'Short', text: `Thanks {{name}}! What can I help you with?` },
    ];
  }

  async generateTemplate(description: string): Promise<{ name: string; content: string; category: string; variables: string[] } | null> {
    await this.ensureLoaded();
    if (!this.config.enabled || !this.config.apiKey) return null;

    try {
      const response = await this.callAPI([
        { role: 'system', content: this.buildSystemPrompt('generateTemplate') },
        { role: 'user', content: `Create a WhatsApp template for: ${description}` },
      ]);

      const cleaned = response.replace(/```json?/gi, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (parsed && parsed.name && parsed.content) {
        return {
          name: parsed.name,
          content: parsed.content,
          category: parsed.category || 'General',
          variables: parsed.variables || ['name', 'company'],
        };
      }
    } catch {
      // Return null if generation fails
    }
    return null;
  }

  async generateAdCopy(brief: { description: string; audience?: string; tone?: string }): Promise<GeneratedAdCopy | null> {
    await this.ensureLoaded();
    if (!this.config.enabled || !this.config.apiKey) {
      return this.fallbackAdCopy(brief);
    }

    try {
      const audience = brief.audience || 'all customers';
      const tone = brief.tone || 'friendly';
      const response = await this.callAPI([
        { role: 'system', content: this.buildSystemPrompt('generateAdCopy') },
        { role: 'user', content: `Brief: ${brief.description}\nAudience: ${audience}\nTone: ${tone}` },
      ]);

      const cleaned = response.replace(/```json?/gi, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (parsed && parsed.title) {
        return {
          title: parsed.title,
          subtitle: parsed.subtitle || '',
          description: parsed.description || '',
          badge: parsed.badge || 'Special Offer',
          ctaLabel: parsed.ctaLabel || 'Order Now',
          emoji: parsed.emoji || '🎯',
          gradient: parsed.gradient || 'linear-gradient(135deg, #0b3e39 0%, #1f8577 100%)',
        };
      }
    } catch {
      // Fall through to template-based copy
    }
    return this.fallbackAdCopy(brief);
  }

  private fallbackAdCopy(brief: { description: string; audience?: string; tone?: string }): GeneratedAdCopy | null {
    const desc = (brief.description || '').trim();
    const tone = brief.tone || 'friendly';
    const lower = desc.toLowerCase();

    // Pick gradient by tone
    const gradients: Record<string, string> = {
      friendly: 'linear-gradient(135deg, #0b3e39 0%, #1f8577 100%)',
      urgent: 'linear-gradient(135deg, #7C2D12 0%, #D97706 100%)',
      premium: 'linear-gradient(135deg, #312E81 0%, #7C5CF0 100%)',
      festive: 'linear-gradient(135deg, #831843 0%, #DB2777 100%)',
      fresh: 'linear-gradient(135deg, #065F46 0%, #059669 100%)',
    };

    if (lower.includes('%') || lower.includes('off') || lower.includes('discount') || lower.includes('sale')) {
      return {
        title: desc.split(/\s+/).slice(0, 6).join(' ') || 'Big Savings Inside',
        subtitle: 'Limited-time offer — grab yours before it ends.',
        description: `${desc.split(/\s+/).slice(0, 12).join(' ')}. This exclusive promotion is available for a limited time only, offering exceptional value for businesses and individuals alike. Don't miss this opportunity to save big on premium print services.`,
        badge: 'Limited Time',
        ctaLabel: 'Shop Now',
        emoji: '🏷️',
        gradient: gradients.urgent,
      };
    }
    if (lower.includes('new') || lower.includes('launch') || lower.includes('introducing')) {
      return {
        title: 'Fresh & New — Just Arrived',
        subtitle: desc || 'Discover our latest products and services.',
        description: `Introducing something fresh and exciting to our product lineup. We've listened to our customers and delivered exactly what you've been asking for. Be among the first to experience this new offering — designed with quality and value in mind.`,
        badge: 'New Arrival',
        ctaLabel: 'Explore',
        emoji: '✨',
        gradient: gradients.fresh,
      };
    }
    if (lower.includes('refer') || lower.includes('friend') || lower.includes('earn')) {
      return {
        title: 'Refer & Earn Rewards',
        subtitle: 'Invite a friend and both of you earn rewards.',
        description: `Share the word about our services with friends, colleagues, and business partners. For every qualified referral that becomes a customer, you'll receive exclusive rewards and credits. It's a simple, straightforward way to earn while helping others discover quality print services.`,
        badge: 'Referral Bonus',
        ctaLabel: 'Refer Now',
        emoji: '🎁',
        gradient: gradients.premium,
      };
    }
    if (lower.includes('member') || lower.includes('loyalty') || lower.includes('tier')) {
      return {
        title: 'Unlock Member Perks',
        subtitle: 'Enjoy exclusive benefits at every loyalty tier.',
        description: `Our loyalty program is designed to reward our most valued customers with exclusive perks, priority service, and special pricing. As a member, you'll gain access to premium features, early access to promotions, and personalized offers tailored to your business needs.`,
        badge: 'Members Only',
        ctaLabel: 'View Benefits',
        emoji: '👑',
        gradient: gradients.premium,
      };
    }
    return {
      title: tone === 'professional'
        ? (desc.split(/\s+/).slice(0, 5).join(' ') || 'Quality You Can Trust')
        : (desc.split(/\s+/).slice(0, 6).join(' ') || 'Great Deals Await'),
      subtitle: desc
        ? 'Take advantage of this special offer today.'
        : 'Explore premium services tailored just for you.',
      description: desc
        ? `${desc}. We pride ourselves on delivering exceptional quality and value, backed by responsive customer service and fast turnaround times. Experience the difference with a team that treats every project — big or small — with the same dedication and care.`
        : `We offer a comprehensive range of business and print services designed to help you look professional and operate efficiently. From concept to completion, our team is committed to quality, reliability, and customer satisfaction at every step.`,
      badge: 'Special Offer',
      ctaLabel: 'Order Now',
      emoji: '🎯',
      gradient: gradients[tone] || gradients.friendly,
    };
  }

  async analyzeSentiment(text: string): Promise<{ sentiment: string; priority: string; summary: string; suggestedTags: string[] } | null> {
    await this.ensureLoaded();
    if (!this.config.enabled || !this.config.apiKey) {
      return {
        sentiment: 'neutral',
        priority: 'normal',
        summary: 'AI analysis not configured',
        suggestedTags: [],
      };
    }

    try {
      const response = await this.callAPI([
        { role: 'system', content: this.buildSystemPrompt('analyzeSentiment') },
        { role: 'user', content: `Analyze this customer message: "${text}"` },
      ]);

      const cleaned = response.replace(/```json?/gi, '').replace(/```/g, '').trim();
      return JSON.parse(cleaned);
    } catch {
      return {
        sentiment: 'neutral',
        priority: 'normal',
        summary: 'Analysis unavailable',
        suggestedTags: [],
      };
    }
  }

  async generateAIResponse(prompt: string, systemInstruction?: string): Promise<string> {
    await this.ensureLoaded();
    if (!this.config.enabled || !this.config.apiKey) {
      throw new Error('AI not configured. Go to Marketing Messages > AI Settings to configure.');
    }

    const messages: { role: string; content: string }[] = [];
    if (systemInstruction) {
      messages.push({ role: 'system', content: systemInstruction });
    }
    messages.push({ role: 'user', content: prompt });

    return this.callAPI(messages);
  }
}

export const aiService = new AIService();
