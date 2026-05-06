/**
 * Standalone seller agent for batch simulations.
 * Uses Claude Sonnet with Anthropic tool_use for the Mellow calculator.
 * Isolated from server.js hint/memory system — pure API layer.
 */

import { SELLER_SYSTEM_PROMPT } from './seller_context.js';

const SELLER_MODEL = 'claude-sonnet-4-6';

const CALCULATOR_TOOL = {
  name: 'mellow_calculator',
  description: 'Calculate savings or cost comparison for a Mellow product. Use when the prospect asks about pricing, ROI, or how much they would save vs their current setup.',
  input_schema: {
    type: 'object',
    properties: {
      product: {
        type: 'string',
        enum: ['CoR', 'CM'],
        description: 'Mellow product: CoR (Contractor of Record, per-payment %) or CM (Contractor Management, flat $35/mo per contractor)',
      },
      contractors: {
        type: 'number',
        description: 'Number of contractors',
      },
      avg_monthly_cost: {
        type: 'number',
        description: 'Average monthly payment per contractor in USD',
      },
    },
    required: ['product', 'contractors', 'avg_monthly_cost'],
  },
};

async function callCalculator(product, contractors, avg_monthly_cost) {
  try {
    const url = `https://lab.mellow.io/calculator?product=${encodeURIComponent(product)}&contractors=${encodeURIComponent(contractors)}&avg_cost=${encodeURIComponent(avg_monthly_cost)}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (resp.ok) {
      return await resp.json();
    }
  } catch {
    // Calculator unreachable — use inline formula
  }

  // Inline formula fallback (mirrors MELLOW_CALCULATOR in seller_context.js)
  if (product === 'CoR') {
    const mellowRate = 0.04;
    const competitorRate = 0.15; // Deel baseline
    const mellowMonthly = contractors * avg_monthly_cost * mellowRate;
    const competitorMonthly = contractors * avg_monthly_cost * competitorRate;
    const monthlySavings = competitorMonthly - mellowMonthly;
    return {
      product,
      contractors,
      avg_monthly_cost,
      mellow_monthly: Math.round(mellowMonthly),
      competitor_monthly: Math.round(competitorMonthly),
      monthly_savings: Math.round(monthlySavings),
      annual_savings: Math.round(monthlySavings * 12),
      note: 'Calculated inline (lab.mellow.io/calculator unavailable). Competitor baseline: Deel 15%.',
    };
  } else {
    const mellowMonthly = contractors * 35;
    return {
      product,
      contractors,
      avg_monthly_cost,
      mellow_monthly: mellowMonthly,
      per_contractor_month: 35,
      note: 'CM flat rate: $35/contractor/month. You retain compliance responsibility.',
    };
  }
}

export async function generateSellerMessage(conversationHistory, anthropic) {
  // conversationHistory: [{role: 'seller'|'buyer', text: string}, ...]
  const messages = conversationHistory.map((m) => ({
    role: m.role === 'seller' ? 'assistant' : 'user',
    content: m.text,
  }));

  // If no messages yet, prompt seller to open
  if (messages.length === 0) {
    messages.push({
      role: 'user',
      content: '[Start the conversation. You are reaching out cold to this prospect. Use a specific contextual opener based on their role and pain.]',
    });
  }

  let response = await anthropic.messages.create({
    model: SELLER_MODEL,
    max_tokens: 400,
    system: SELLER_SYSTEM_PROMPT,
    tools: [CALCULATOR_TOOL],
    messages,
  });

  // Handle tool_use
  if (response.stop_reason === 'tool_use') {
    const toolUseBlock = response.content.find((b) => b.type === 'tool_use');
    if (toolUseBlock && toolUseBlock.name === 'mellow_calculator') {
      const { product, contractors, avg_monthly_cost } = toolUseBlock.input;
      const calcResult = await callCalculator(product, contractors, avg_monthly_cost);

      const followUpMessages = [
        ...messages,
        { role: 'assistant', content: response.content },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUseBlock.id,
              content: JSON.stringify(calcResult),
            },
          ],
        },
      ];

      response = await anthropic.messages.create({
        model: SELLER_MODEL,
        max_tokens: 400,
        system: SELLER_SYSTEM_PROMPT,
        tools: [CALCULATOR_TOOL],
        messages: followUpMessages,
      });
    }
  }

  const textBlock = response.content.find((b) => b.type === 'text');
  return textBlock?.text?.trim() || '';
}
