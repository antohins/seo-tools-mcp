import { describe, expect, it } from 'vitest';
import { withToolDefaults } from '../shared/src/mcp.js';

/** Мини-сервер, запоминающий переданные конфиги инструментов. */
function fakeServer() {
  const tools = new Map<string, { title?: string; annotations?: Record<string, unknown> }>();
  const srv = { registerTool: (name: string, config: Record<string, unknown>) => tools.set(name, config) };
  return { srv: withToolDefaults(srv), tools };
}

describe('withToolDefaults', () => {
  it('проставляет read-only и open-world по умолчанию', () => {
    const { srv, tools } = fakeServer();
    srv.registerTool('ga4_top_pages', { description: 'x' }, () => {});
    expect(tools.get('ga4_top_pages')?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
  });

  it('человекочитаемый title из имени: префикс сервера → бренд', () => {
    const { srv, tools } = fakeServer();
    srv.registerTool('ga4_top_pages', { description: 'x' }, () => {});
    srv.registerTool('ywm_sqi_history', { description: 'x' }, () => {});
    srv.registerTool('aparser_ping', { description: 'x' }, () => {});
    expect(tools.get('ga4_top_pages')?.title).toBe('GA4: top pages');
    expect(tools.get('ywm_sqi_history')?.title).toBe('Яндекс.Вебмастер: sqi history');
    expect(tools.get('aparser_ping')?.title).toBe('A-Parser: ping');
  });

  it('явные annotations и title инструмента ПЕРЕВЕШИВАЮТ умолчания', () => {
    // критично: инструменты, которые пишут в конфиг, обязаны уметь снять readOnlyHint,
    // иначе аннотация станет ровно тем «молча неверным» фактом, который она должна убрать
    const { srv, tools } = fakeServer();
    srv.registerTool('gsc_set_credentials', { description: 'x', annotations: { readOnlyHint: false } }, () => {});
    srv.registerTool('custom_tool', { description: 'x', title: 'Своё имя' }, () => {});
    expect(tools.get('gsc_set_credentials')?.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    expect(tools.get('custom_tool')?.title).toBe('Своё имя');
  });

  it('неизвестный префикс не ломает title', () => {
    const { srv, tools } = fakeServer();
    srv.registerTool('unknown_thing', { description: 'x' }, () => {});
    expect(tools.get('unknown_thing')?.title).toBe('unknown: thing');
  });
});
