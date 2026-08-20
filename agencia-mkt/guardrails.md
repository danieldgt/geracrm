# Guardrails — isto mexe com dinheiro de terceiro

> ⚠️ Todo o resto do sistema pode errar e ser corrigido. Aqui o erro sai do caixa do cliente e não
> volta. A regra que organiza tudo: **o agente propõe, o sistema aplica dentro de limites, o humano
> aprova o que sai dos limites.**

## 1. Gasto

| Guardrail | Regra |
|---|---|
| **Teto diário por conta** | validado **em código**, não só configurado na plataforma. ⚠️ Confiar no teto da plataforma é confiar num sistema que não conhece nosso limite contratual. |
| **Delta máximo por ciclo** | nenhuma mudança de orçamento acima de ~20%, no máximo 1× ao dia |
| **Frequência mínima entre ações** | ⚠️ mexer demais reseta a *learning phase* e destrói a performance que se queria melhorar |
| **Piso de massa** | não pausar nem escalar sem volume mínimo de dados — decidir com 12 cliques é ruído |
| **Kill switch** | global, por tenant e por conta. Um comando, efeito imediato. |
| **Dry-run por padrão** | ⚠️ **as primeiras semanas o agente só escreve o que faria.** Compara-se com o que o humano faria. Escrita só é liberada quando o histórico bate. |
| **Idempotência** | retry não duplica veiculação nem dobra orçamento. Handler idempotente é regra da casa. |
| **Auditoria total** | ator, ação, entidade, valor antes/depois, justificativa. O helper `auditar()` e a tabela `auditoria` já existem — usar, não recriar. |

⚠️ **Aprovação humana obrigatória**, sem exceção na primeira fase: criar conta ou campanha nova,
subir orçamento acima do delta, publicar criativo novo, alterar público, e qualquer ação em
categoria especial de anúncio.

## 2. Plataformas de anúncio

- **Só API oficial.** Meta Marketing API, Google Ads API, TikTok Business API. ⚠️ Automatizar a
  interface do Gerenciador (bot de navegador) viola os termos e derruba conta **e** Business
  Manager — inclusive contas de clientes ligadas a ele. É o equivalente, no lado da mídia, ao risco
  do canal não-oficial do ADR-021.
- **Acesso via Business Manager como parceiro**, com permissão mínima. ⚠️ Nunca pedir a senha do
  cliente; nunca operar de dentro do usuário pessoal dele.
- **A conta de anúncio é do cliente e o meio de pagamento é dele** (AMK-002). A agência opera, não
  financia.
- **Rate limit e retry com backoff** por conta — estourar limite derruba a operação de todos os
  clientes daquele app.
- **Revisão de política antes de publicar**, sempre. Reprovação repetida degrada a reputação da
  conta, não só do anúncio.
- ⚠️ **Categorias especiais** (crédito, emprego, moradia, questões sociais/eleições/política):
  restringem segmentação e têm revisão própria. Fora de escopo na primeira fase.

## 3. Canal de WhatsApp

O ponto de maior risco operacional da agência, porque o volume de conversa cresce com a verba.

- ⚠️ **SDR autônomo só no canal oficial da Meta** (AMK-004). Agente autônomo em volume no
  não-oficial (PlugZapi/Z-API) é banimento com data marcada — e a interface já mostra esse risco
  por decisão do ADR-021.
- **Todo envio passa pelo gateway único** (`canais/gateway.ts`): opt-out → estado do canal →
  credencial → janela de 24h. Sem atalho, sem exceção para "é só um teste".
- **Priorizar Click-to-WhatsApp**: o lead inicia a conversa, a janela de 24h nasce aberta, a
  resposta é texto livre e não depende de template aprovado.
- **Aquecimento de frota** (`0037`) vale para número novo de atendimento, não só para disparo.
- **Handoff para humano** por regra e por incerteza — ⚠️ conversa nunca fica sem resposta.

## 4. LGPD e dado pessoal

- **Base legal registrada na captura**: o texto exato do consentimento e o timestamp ficam na
  origem do lead. ⚠️ "Aceitou os termos" sem guardar *qual* texto é indefensável em auditoria.
- **Opt-out é invariante, não filtro.** Já é assim no CRM (`contato.recebe_campanhas`,
  `lista_bloqueio`) e vale para todo caminho do agente, inclusive o primeiro contato.
- **Minimização no prompt**: ⚠️ CPF, CNPJ completo e endereço **não melhoram** a qualificação e
  saem do nosso perímetro ao ir para o provedor de IA. Não vão.
- **Hash antes de sair**: telefone e e-mail enviados às plataformas para correspondência vão
  hasheados (SHA-256, normalizado), nunca em claro.
- **Isolamento entre clientes**: RLS (ADR-001). Toda tabela nova nasce com `aplicar_rls()` e com
  teste provando que o tenant A não lê o tenant B.
- **Retenção**: lead descartado não fica indefinidamente. A política de retenção do CRM (`0042`)
  se estende à origem de mídia.
- ⚠️ **O dado do lead é do cliente, não da agência.** Não se usa a base de um cliente para
  alimentar público de outro — nem "anonimizado". Isso quebra contrato e confiança de uma vez só.

## 5. Marca e conteúdo

- **Base de conhecimento versionada por cliente**, com o que o SDR pode e **não pode** afirmar.
- ⚠️ **Preço, prazo e disponibilidade não saem do prompt** — saem do domínio (tabela de preço,
  saldo, regra de pedido mínimo). Regra que já é lei na skill `geracrm-ia`: nenhuma regra de
  negócio mora no prompt, porque ali ela falha em silêncio e ninguém testa.
- **Sem promessa de resultado** em copy — além de política de plataforma, é risco jurídico do
  cliente.
- **Toda conversa conduzida por agente fica registrada** e é revisável pelo cliente.

## 6. Os sinais de que algo saiu do trilho

O Vigia de anomalia observa, de hora em hora:

| Sinal | Leitura |
|---|---|
| Gasto fora da banda esperada | falha de guardrail ou mudança na plataforma |
| Veiculação parada sem ordem | reprovação de política, cartão recusado, conta suspensa |
| Evento parou de chegar | ⚠️ pixel/CAPI quebrado — **o pior**, porque o painel continua bonito |
| CPL despencou junto com a qualificação | tráfego lixo, não vitória |
| Taxa de handoff do SDR subindo | prompt ou base de conhecimento degradados |
| Conversão devolvida falhando | loop aberto — otimização voltando a ser cega |

⚠️ Silêncio nunca pode parecer "está tudo bem". Análise indisponível é alerta, não ausência dele.
