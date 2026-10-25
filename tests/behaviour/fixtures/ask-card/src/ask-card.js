// The question card the agents already send to Kun in Feishu (interactive card JSON, schema 2.0).
// Each option is a button; the input at the bottom takes a free-form answer when no option fits.

export function buildAskCard({ title, question, options, allowOther = true }) {
  const elements = [
    { tag: 'markdown', content: question },
    { tag: 'column_set', columns: options.map((option, index) => ({
      tag: 'column', width: 'weighted', weight: 1,
      elements: [{ tag: 'button', text: { tag: 'plain_text', content: option.label },
        type: index === 0 ? 'primary' : 'default', value: { answer: option.value } }],
    })) },
  ];
  if (allowOther) {
    elements.push({ tag: 'form', name: 'other', elements: [
      { tag: 'input', name: 'free_text', placeholder: { tag: 'plain_text', content: '都不合适？直接写你的想法' } },
      { tag: 'button', text: { tag: 'plain_text', content: '提交' }, type: 'default', action_type: 'form_submit', name: 'submit_other' },
    ] });
  }
  return { schema: '2.0', header: { title: { tag: 'plain_text', content: title }, template: 'blue' }, body: { elements } };
}
