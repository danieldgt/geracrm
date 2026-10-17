import { ChangeDetectionStrategy, Component, effect, inject, input, signal, untracked } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { LIMITES_SLA, type EstadoSlaConfig } from '@geracrm/shared'

type Estado = 'carregando' | 'pronto' | 'erro' | 'sem_permissao'

/**
 * SLA DO HANDOFF por número (raia P18, ADR-034) — dentro da configuração do
 * canal. Lê `GET /v1/canais/:id/sla`; grava com `PUT` (só administrador; a API
 * audita antes/depois). Minutos ÚTEIS: contam só dentro do horário de
 * atendimento do número, com feriados.
 */
@Component({
  selector: 'app-sla-config',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="sla" aria-labelledby="sla-titulo">
      <h3 id="sla-titulo" class="titulo">SLA quando o agente transfere para uma pessoa</h3>
      @switch (estado()) {
        @case ('carregando') { <div class="esq" aria-busy="true" aria-label="Carregando o SLA"></div> }
        @case ('sem_permissao') { <p class="dica">Você não tem acesso à configuração de SLA deste número.</p> }
        @case ('erro') {
          <p class="falha" role="alert">Não foi possível carregar o SLA. <button type="button" class="link" (click)="carregar()">Tentar de novo</button></p>
        }
        @case ('pronto') {
          <p class="dica">
            Contado em <b>minutos úteis</b> — só dentro do horário de atendimento do número, sem feriados{{
              horarioConfigurado() ? '.' : ' (sem horário configurado, o relógio corre o dia todo).' }}
            @if (padrao()) { Este número usa o padrão. }
          </p>
          <div class="grade">
            <label class="campo">Avisar o gestor após (min)
              <input type="number" inputmode="numeric" [min]="limites.slaMin" [max]="limites.slaMax"
                     [value]="sla()" (input)="sla.set(+$any($event.target).value)" [attr.aria-invalid]="campoErro() === 'slaMinutos'" />
            </label>
            <label class="campo">Liberar para qualquer pessoa após (min)
              <input type="number" inputmode="numeric" [max]="limites.reatribuicaoMax"
                     [value]="reatribuicao()" (input)="reatribuicao.set(+$any($event.target).value)"
                     [attr.aria-invalid]="campoErro() === 'reatribuicaoMinutos'" />
            </label>
          </div>
          <label class="check">
            <input type="checkbox" [checked]="aviso()" (change)="aviso.set($any($event.target).checked)" />
            Mandar UMA mensagem de espera ao cliente no prazo (sem prometer horário; respeita opt-out e a janela de 24 h)
          </label>
          <div class="acoes">
            <button class="btn btn--secundario" type="button" (click)="salvar()" [disabled]="salvando()">
              {{ salvando() ? 'Salvando…' : 'Salvar SLA' }}</button>
            @if (ok()) { <span class="ok" role="status">{{ ok() }}</span> }
            @if (erro()) { <span class="falha" role="alert">{{ erro() }}</span> }
          </div>
        }
      }
    </section>
  `,
  styles: `
    .sla { display: grid; gap: var(--espacamento-3); padding-top: var(--espacamento-4); border-top: 1px solid var(--borda); }
    .titulo { margin: 0; font-size: 14px; font-weight: 600; color: var(--texto); }
    .dica { margin: 0; color: var(--texto-suave); font-size: 12px; }
    .esq { height: 72px; border-radius: var(--raio-controle); background: var(--superficie); }
    .grade { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(200px, 100%), 1fr)); gap: var(--espacamento-3); align-items: end; }
    .campo { display: flex; flex-direction: column; gap: var(--espacamento-2); color: var(--texto); font-size: 13px; min-width: 0; }
    .campo input { padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle);
      background: var(--fundo); color: var(--texto); font: inherit; min-width: 0; }
    .campo input[aria-invalid='true'] { border-color: var(--erro); }
    .check { display: flex; gap: var(--espacamento-2); align-items: flex-start; font-size: 13px; color: var(--texto); }
    .acoes { display: flex; align-items: center; gap: var(--espacamento-3); flex-wrap: wrap; }
    .ok { color: var(--sucesso); font-size: 13px; }
    .falha { margin: 0; color: var(--erro); font-size: 13px; }
    .link { font: inherit; color: var(--acao); background: none; border: 0; padding: 0; cursor: pointer; text-decoration: underline; }
  `,
})
export class SlaConfigComponente {
  readonly canalId = input.required<string>()
  readonly limites = LIMITES_SLA

  readonly #http = inject(HttpClient)
  readonly estado = signal<Estado>('carregando')
  readonly sla = signal(30)
  readonly reatribuicao = signal(60)
  readonly aviso = signal(true)
  readonly padrao = signal(true)
  readonly horarioConfigurado = signal(false)
  readonly salvando = signal(false)
  readonly ok = signal('')
  readonly erro = signal('')
  readonly campoErro = signal<string | null>(null)

  constructor() {
    effect(() => {
      this.canalId()
      untracked(() => void this.carregar())
    })
  }

  async carregar(): Promise<void> {
    const id = this.canalId()
    this.estado.set('carregando')
    this.ok.set(''); this.erro.set(''); this.campoErro.set(null)
    try {
      const r = await firstValueFrom(this.#http.get<EstadoSlaConfig>(`/v1/canais/${id}/sla`))
      if (id !== this.canalId()) return
      this.sla.set(r.config.slaMinutos)
      this.reatribuicao.set(r.config.reatribuicaoMinutos)
      this.aviso.set(r.config.avisoEspera)
      this.padrao.set(r.padrao)
      this.horarioConfigurado.set(r.horarioConfigurado)
      this.estado.set('pronto')
    } catch (e) {
      if (id !== this.canalId()) return
      this.estado.set(e instanceof HttpErrorResponse && e.status === 403 ? 'sem_permissao' : 'erro')
    }
  }

  async salvar(): Promise<void> {
    this.salvando.set(true)
    this.ok.set(''); this.erro.set(''); this.campoErro.set(null)
    try {
      await firstValueFrom(this.#http.put(`/v1/canais/${this.canalId()}/sla`, {
        slaMinutos: this.sla(), reatribuicaoMinutos: this.reatribuicao(), avisoEspera: this.aviso(),
      }))
      this.padrao.set(false)
      this.ok.set('SLA salvo. Vale para os próximos atendimentos transferidos.')
    } catch (e) {
      const corpo = e instanceof HttpErrorResponse ? (e.error as { mensagem?: string; campos?: string[] } | null) : null
      if (e instanceof HttpErrorResponse && e.status === 403) this.erro.set('Só um administrador altera o SLA.')
      else this.erro.set(corpo?.mensagem ?? 'Não foi possível salvar o SLA.')
      this.campoErro.set(corpo?.campos?.[0] ?? null)
    } finally {
      this.salvando.set(false)
    }
  }
}
