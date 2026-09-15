import type { ConversationState } from "./memory.js";

const nearestStorePattern = /\b(?:loja|unidade)\s+mais\s+pr[oó]xima\b|\bqual\s+(?:a\s+)?(?:loja|unidade)\s+mais\s+perto\b/iu;
const screenIssuePattern = /\b(?:problema|defeito|falha)\b.{0,35}\b(?:tela|display|touch)\b|\b(?:tela|display|touch)\b.{0,35}\b(?:problema|defeito|falha)\b/iu;
const usefulScreenSymptomPattern = /\b(?:quebrad[ao]|trincad[ao]|rachad[ao]|mancha|linha|listr[ao]|pisc(?:a|ando)|apag(?:a|ada|ou)|escura|sem\s+imagem|n[aã]o\s+(?:acende|liga|responde)|touch|toque|descol(?:ou|ando)|levant(?:ou|ando)|verde|branca|preta)\b/iu;
const vagueOpeningPattern = /^(?:oi+|ol[aá]|bom\s+dia|boa\s+tarde|boa\s+noite|preciso\s+de\s+ajuda|pode\s+me\s+ajudar)[!,.?\s]*$/iu;

export type ServiceScopePolicy = {
  deniedBrands?: readonly string[];
  outOfScopeMessage?: string;
};

export function outOfScopeServiceAnswer(input: string, policy?: ServiceScopePolicy): string | undefined {
  const brands = (policy?.deniedBrands ?? []).map(value => value.normalize("NFKC").trim()).filter(Boolean);
  if (!brands.length || !/\b(?:consert|repar|manuten[cç][aã]o|trocar|problema|defeito)\w*/iu.test(input)) return undefined;
  const normalized = input.normalize("NFKC");
  const denied = brands.find(brand => new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(brand)}(?:$|[^\\p{L}\\p{N}])`, "iu").test(normalized));
  if (!denied) return undefined;
  return policy?.outOfScopeMessage?.trim()
    || `Não trabalhamos com aparelhos ${denied}. Posso ajudar somente com os produtos e serviços oferecidos pela empresa.`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function knownLocation(state: ConversationState) {
  return state.endereco || state.cep || state.bairro || state.cidade;
}

export function proactiveIntakeAnswer(
  input: string,
  state: ConversationState,
  messageCount: number,
  welcomeMessage = "",
): string | undefined {
  if (nearestStorePattern.test(input) && !knownLocation(state)) {
    return "Para indicar a loja realmente mais próxima, preciso saber onde você está. Pode me informar seu bairro, cidade, CEP ou endereço atual?";
  }

  if (screenIssuePattern.test(input) && !usefulScreenSymptomPattern.test(input)) {
    const missingModel = !(state.modelo || state.aparelho);
    return missingModel
      ? "Para entender o problema antes de falar em serviço ou orçamento, qual é o aparelho e modelo? E o que exatamente acontece com a tela: ela está quebrada, sem imagem, piscando, com manchas ou sem responder ao toque?"
      : "O que exatamente acontece com a tela: ela está quebrada, sem imagem, piscando, com manchas ou sem responder ao toque? Assim consigo direcionar o serviço correto sem presumir uma troca.";
  }

  if (messageCount === 1 && vagueOpeningPattern.test(input)) {
    return welcomeMessage.trim() || undefined;
  }

  return undefined;
}
