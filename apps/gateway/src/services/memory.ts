export type ConversationState = Record<string, string>;

const first = (input: string, pattern: RegExp) => input.match(pattern)?.[1]?.trim();

export function extractConversationState(input: string, previous: ConversationState = {}): ConversationState {
  const next = { ...previous };
  const asksNearestStore = /\b(?:loja|unidade)\s+mais\s+pr[oó]xima\b|\bqual\s+(?:a\s+)?(?:loja|unidade)\s+mais\s+perto\b/iu.test(input);
  const phone = first(
    input,
    /(?<![\p{L}\p{N}_-])(?:\+?55[\s.-]*)?(\(?\d{2}\)?[\s.-]*9?\d{4}[-\s.]?\d{4})(?![\p{L}\p{N}_-])/u,
  );
  const name = first(input, /(?:meu nome (?:é|e)|me chamo|sou o|sou a)\s+([\p{L}][\p{L}\s'-]{1,60}?)(?=\s+(?:e\s+)?(?:meu|minha|telefone|celular|moro|tenho)\b|[,.!?]|$)/iu);
  const city = first(input, /(?:moro em|sou de|cidade(?: é|:))\s+([\p{L}][\p{L}\s'-]{1,60})/iu);
  const postalCode = first(input, /\b(\d{5}[-.\s]?\d{3})\b/u);
  const address = first(
    input,
    /(?:meu endere[cç]o (?:é|e)|estou (?:na|no|em)|fico (?:na|no|em)|moro (?:na|no))\s+(.{5,140}?)(?=[.!?]|$)/iu,
  );
  const neighborhood = first(input, /(?:bairro|regi[aã]o)(?:\s+(?:é|e|de|do|da|em))?\s*[:\-]?\s*([\p{L}][\p{L}\s'-]{1,60}?)(?=[,.!?]|$)/iu);
  const model = first(
    input,
    /\b((?:iPhone|iPad|MacBook|iMac|Apple Watch)(?:\s+(?:\d{1,2}|Pro|Max|Plus|Air|mini|Ultra|Series|SE)){0,4})\b/iu,
  );
  const defect = first(input, /(?:defeito|problema|não funciona|parou de funcionar)(?: é|:| no| na)?\s*(.{3,180})/iu);
  const date = first(input, /\b(\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)\b/);
  const clock = input.match(/\b((?:[01]?\d|2[0-3]))(?::([0-5]\d)|\s*h(?:oras?)?(?:\s*([0-5]\d))?)\b/iu);
  const time = clock
    ? `${clock[1].padStart(2, "0")}:${(clock[2] || clock[3] || "00").padStart(2, "0")}`
    : undefined;
  const relativeDate = /\bhoje\b/iu.test(input) ? "hoje" : /\bamanh[aã]\b/iu.test(input) ? "amanhã" : undefined;
  const cpf = first(input, /\bcpf\s*(?:é|e|:|-)?\s*(\d{3}[.\s-]?\d{3}[.\s-]?\d{3}[-.\s]?\d{2})(?!\d)/iu);
  const email = first(input, /\b([\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+)\b/iu);
  const service = first(
    input,
    /(?:servi[cç]o(?: desejado)?|preciso (?:fazer|trocar|consertar|reparar)|quero (?:fazer|trocar|consertar|reparar)|(?:quero\s+)?(?:agendar|marcar)(?:\s+um|\s+uma)?)(?:\s+(?:é|e|de|do|da|um|uma))?\s*[:\-]?\s*(.{3,100}?)(?=\s+(?:na|no|pela|para a|para o)\s+(?:loja|unidade)\b|\s+para\s+(?:meu|minha|o|a)\b|\s+em\s+\d{1,2}[/-]|[.!?]|$)/iu,
  );
  const usableService = service && !/^(?:(?:hoje|amanh[aã])\b|(?:[01]?\d|2[0-3])(?::[0-5]\d|\s*h(?:oras?)?)\b)/iu.test(service)
    ? service
    : undefined;
  const desiredUnit = first(
    input,
    /(?:unidade|loja)(?: de prefer[eê]ncia| desejada| mais pr[oó]xima)?(?:\s+(?:é|e|da|de|do|em))?\s*[:\-]?\s*([\p{L}\d][\p{L}\d\s'-]{1,70}?)(?=\s+em\s+\d{1,2}[/-]|\s+(?:às|as)\s+\d{1,2}:\d{2}|[,.!?]|$)/iu,
  );
  const scheduledUnit = first(
    input,
    /(?:agendar|marcar|remarcar)\s+(?:na|no|para a|para o)\s+(?:unidade|loja)\s+([\p{L}\d][\p{L}\d\s'-]{1,70}?)(?=\s+em\s+\d{1,2}[/-]|\s+(?:às|as)\s+\d{1,2}:\d{2}|[,.!?]|$)/iu,
  );
  if (phone) next.telefone = phone.replace(/\D/g, "");
  if (name) next.nome = name.replace(/[.!?].*$/, "").trim();
  if (city) next.cidade = city.replace(/[.!?].*$/, "").trim();
  if (postalCode) next.cep = postalCode.replace(/\D/g, "");
  if (address) next.endereco = address.trim();
  if (neighborhood) next.bairro = neighborhood.trim();
  if (model) next.modelo = model.replace(/[.!?,].*$/, "").trim();
  if (defect) next.defeito = defect.replace(/[.!?].*$/, "").trim();
  if (date) next.dataDesejada = date;
  else if (relativeDate) next.dataDesejada = relativeDate;
  if (time) next.horarioDesejado = time;
  if (cpf) next.cpf = cpf.replace(/\D/g, "");
  if (email) next.email = email.toLocaleLowerCase("pt-BR");
  if (usableService) next.servico = usableService.replace(/[.!?].*$/, "").trim().replace(/^(?:a|o|um|uma)\s+/iu, "");
  if (desiredUnit) {
    const value = desiredUnit.replace(/[.!?].*$/, "").trim();
    if (!/^(?:mais\s+(?:perto|pr[oó]xima)(?:\s+de\s+mim)?|perto\s+de\s+mim)$/iu.test(value)) {
      next.unidadeDesejada = value;
    }
  }
  if (scheduledUnit) next.unidadeAgendamento = scheduledUnit.replace(/[.!?].*$/, "").trim();
  if (asksNearestStore) next.buscaLojaProxima = "true";

  if (previous.buscaLojaProxima === "true" || asksNearestStore) {
    const alternative = input.match(/^\s*e\s+([\p{L}][\p{L}\s'-]{1,60})\s*[?!.]*\s*$/iu)?.[1]?.trim();
    const bareLocation = input.match(/^\s*([\p{L}][\p{L}\s'-]{1,60})\s*[?!.]*\s*$/u)?.[1]?.trim();
    if (alternative) {
      next.cidade = alternative;
      delete next.cep;
      delete next.endereco;
      delete next.bairro;
    } else if (bareLocation && !asksNearestStore && !/^(?:sim|n[aã]o|quero|pode|ok|obrigad[oa])$/iu.test(bareLocation)) {
      next.bairro = bareLocation;
    }
  }
  return next;
}

export function deterministicSummary(messages: { role: string; content: string }[], state: ConversationState): string {
  const facts = Object.entries(state).map(([key, value]) => `${key}: ${value}`).join("; ");
  const header = `Dados confirmados: ${facts || "nenhum"}\nContexto compactado:\n`;
  const transcript = messages
    .map(message => `${message.role}: ${message.content.replace(/\s+/g, " ").trim().slice(0, 800)}`)
    .join("\n");
  const budget = 8_000 - header.length;
  if (transcript.length <= budget) return header + transcript;
  const marker = "\n[...trecho intermediário compactado...]\n";
  const side = Math.floor((budget - marker.length) / 2);
  return header + transcript.slice(0, side) + marker + transcript.slice(-side);
}
