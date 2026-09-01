-- 0079_agente_reabrir_janela.sql
--
-- A TRAVA DE "JÁ CONVERSEI NESTA CONVERSA" GANHA PRAZO.
--
-- ⚠️ `reabrir_apos_encerrada = false` (o padrão) fazia o agente calar NAQUELA
--    conversa **para sempre**. A intenção era boa e continua valendo: o cliente
--    ouviu "vou chamar alguém" e não pode receber o robô de volta em seguida —
--    é a forma mais rápida de destruir a confiança no handoff.
--
--    Só que "não reabrir" virou "nunca mais". Medido em produção hoje (01/09):
--    uma conversa de teste encerrada em 28/08 respondeu `sessao_ja_encerrada` a
--    SEIS mensagens seguidas, com a equipe offline e o agente ligado. Dois dias
--    depois, com outro assunto e ninguém na mesa, o silêncio não protege
--    ninguém — é só silêncio, e do tipo que ninguém no CRM enxerga.
--
-- ⚠️ **Este DEFAULT muda o comportamento de todos os canais**, ao contrário do
--    0078, onde todo default repetia o que já existia. É deliberado e é decisão
--    do dono do produto: o comportamento anterior era um defeito, não uma
--    escolha que alguém tenha feito. Quem quiser a trava quase perpétua de volta
--    põe 720 na tela.
--
-- ⚠️ Aditiva: uma coluna NOT NULL DEFAULT, sem tocar em nada. Roda com a versão
--    anterior ainda atendendo (ADR-006) — a API antiga ignora a coluna.

ALTER TABLE agente_config
    ADD COLUMN horas_para_reabrir smallint NOT NULL DEFAULT 24;

-- ⚠️ Mesma rede de segurança das outras faixas (0078): a tela e o
--    `validarRegrasAgente` de packages/shared recusam com a frase corretiva;
--    isto impede que script, teste ou UPDATE à mão gravem o que o agente não
--    sabe executar.
ALTER TABLE agente_config
    ADD CONSTRAINT agente_reabrir_sensato CHECK (horas_para_reabrir BETWEEN 1 AND 720);

COMMENT ON COLUMN agente_config.horas_para_reabrir IS
    '⚠️ Por quantas horas uma conversa ENCERRADA pelo agente fica sem ele — só '
    'vale quando reabrir_apos_encerrada = false. Antes desta coluna a trava não '
    'expirava, e o agente ficava permanentemente mudo naquela conversa. A trava '
    'também cai antes do prazo quando um atendimento HUMANO é encerrado depois '
    'da sessão: o ciclo do handoff já foi fechado por gente.';
