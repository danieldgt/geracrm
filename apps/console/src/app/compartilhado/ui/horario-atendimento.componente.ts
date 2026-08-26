import { Component, ChangeDetectionStrategy, model } from '@angular/core'

/** Faixa de atendimento de um dia. `null` = fechado. */
export interface Faixa { de: string; ate: string }
export type HorarioAtendimento = Record<string, Faixa | null>

export const DIAS = [
  ['seg', 'Seg'], ['ter', 'Ter'], ['qua', 'Qua'], ['qui', 'Qui'],
  ['sex', 'Sex'], ['sab', 'Sáb'], ['dom', 'Dom'],
] as const

/** ⚠️ Ao marcar um dia, ele nasce com esta faixa — nunca vazio. */
const PADRAO: Faixa = { de: '08:00', ate: '18:00' }

/**
 * Editor de horário de atendimento — os sete dias, cada um aberto ou fechado.
 *
 * ⚠️ Mora em `compartilhado` porque aparece em DUAS telas: Config. do Canal (a
 * fonte da verdade, por número) e Configurações Gerais (o espelho, onde as
 * pessoas vão procurar primeiro). Duplicar o editor garantiria que as duas telas
 * divergissem — e a divergência apareceria como "salvei e não pegou".
 *
 * ⚠️ **Puramente apresentacional**: não sabe de HTTP nem de canal. Quem carrega e
 * salva é a tela; isto aqui só edita o objeto.
 */
@Component({
  selector: 'ui-horario-atendimento',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <fieldset class="horario">
      <legend class="txt-rotulo">Horário de atendimento</legend>
      @for (d of dias; track d[0]) {
        <div class="dia">
          <label class="chk">
            <input type="checkbox" [checked]="aberto(d[0])"
                   (change)="alternarDia(d[0], $any($event.target).checked)" />
            {{ d[1] }}
          </label>
          @if (aberto(d[0])) {
            <input class="hora" type="time" [value]="hora(d[0], 'de')"
                   (input)="setHora(d[0], 'de', $any($event.target).value)" aria-label="Abre" />
            <span class="ate">às</span>
            <input class="hora" type="time" [value]="hora(d[0], 'ate')"
                   (input)="setHora(d[0], 'ate', $any($event.target).value)" aria-label="Fecha" />
          } @else { <span class="fechado">fechado</span> }
        </div>
      }
    </fieldset>
  `,
  styles: `
    .horario { border: 1px solid var(--borda); border-radius: var(--raio-painel);
      padding: var(--espacamento-3) var(--espacamento-4); margin: 0; display: grid; gap: var(--espacamento-2); }
    .horario legend { padding: 0 var(--espacamento-1); }
    .dia { display: flex; align-items: center; gap: var(--espacamento-3); flex-wrap: wrap; }
    .chk { display: inline-flex; align-items: center; gap: var(--espacamento-2);
      min-width: 84px; color: var(--texto); font-size: 13px; }
    .hora { padding: var(--espacamento-1) var(--espacamento-2); border: 1px solid var(--borda-controle);
      border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; }
    .ate { color: var(--texto-suave); font-size: 12px; }
    .fechado { color: var(--texto-suave); font-size: 13px; }
  `,
})
export class HorarioAtendimentoComponente {
  readonly horario = model.required<HorarioAtendimento>()
  readonly dias = DIAS

  aberto(dia: string): boolean { return !!this.horario()[dia] }
  hora(dia: string, campo: 'de' | 'ate'): string { return this.horario()[dia]?.[campo] ?? '' }

  alternarDia(dia: string, aberto: boolean): void {
    this.horario.set({ ...this.horario(), [dia]: aberto ? { ...PADRAO } : null })
  }

  setHora(dia: string, campo: 'de' | 'ate', valor: string): void {
    const atual = this.horario()[dia] ?? PADRAO
    this.horario.set({ ...this.horario(), [dia]: { ...atual, [campo]: valor } })
  }
}

/**
 * Só os dias ABERTOS vão para a API — dia fechado é ausência de chave, não uma
 * faixa vazia. ⚠️ Enviar `{de:'',ate:''}` faria a régua do servidor tratar o dia
 * como declarado, e a resposta de ausência sairia em horário comercial.
 */
export function somenteDiasAbertos(h: HorarioAtendimento): Record<string, Faixa> {
  const saida: Record<string, Faixa> = {}
  for (const [chave] of DIAS) {
    const f = h[chave]
    if (f?.de && f?.ate) saida[chave] = f
  }
  return saida
}
