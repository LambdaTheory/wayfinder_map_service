/** Exact native question tools; similarly named tools are not evidence of a human exchange. */
export const questionTool = (name: string): 'blocking' | 'async' | null =>
  /^(?:functions\.)?(?:request_user_input|AskUserQuestion)$/.test(name) ? 'blocking'
    : /^(?:functions\.)?request_user_input_async$/.test(name) ? 'async' : null;
