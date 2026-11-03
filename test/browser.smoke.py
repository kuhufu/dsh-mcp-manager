import json, os
from playwright.sync_api import sync_playwright, expect
import subprocess, time, urllib.request
server = subprocess.Popen(['node', 'test/browser-harness.mjs'], stdout=subprocess.DEVNULL)
try:
    for _ in range(100):
        try:
            urllib.request.build_opener(urllib.request.ProxyHandler({})).open('http://127.0.0.1:4199', timeout=1).close()
            break
        except OSError:
            time.sleep(0.05)
    else:
        raise RuntimeError('Browser harness did not start')
    with sync_playwright() as p:
        browser=p.chromium.launch(channel=os.environ.get('MCP_QA_BROWSER'),headless=True)
        page=browser.new_page(viewport={'width':1024,'height':900})
        errors=[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.on('console',lambda message: errors.append(message.text) if message.type=='error' and '404' not in message.text else None)
        page.goto('http://127.0.0.1:4199');page.wait_for_load_state('networkidle')
        page.get_by_role('button',name='添加第一个服务器').click()
        dialog=page.get_by_role('dialog')
        expect(dialog.get_by_label('名称',exact=True)).to_be_focused()
        dialog.get_by_label('名称',exact=True).fill('ui-demo')
        dialog.get_by_label('命令',exact=True).fill('node')
        dialog.get_by_label('参数',exact=False).fill(os.path.abspath('test/fake-server.mjs'))
        dialog.get_by_label('工具调用超时（毫秒）').fill('120000')
        dialog.get_by_role('button',name='保存',exact=True).click()
        expect(dialog).not_to_be_visible()
        page.get_by_role('button',name='刷新状态').click()
        expect(page.locator('.dshmcp-state[data-state=ready]')).to_be_visible(timeout=10000)
        page.get_by_role('button',name='编辑 ui-demo',exact=True).click()
        expect(page.get_by_label('工具调用超时（毫秒）')).to_have_value('120000')
        held=[]
        page.route('**/api/mcp-manager.save', lambda route: held.append(route))
        page.get_by_label('工具调用超时（毫秒）').fill('121000')
        with page.expect_request('**/api/mcp-manager.save'):
            dialog.get_by_role('button',name='保存',exact=True).click()
        expect(dialog.get_by_role('button',name='保存中…',exact=True)).to_be_disabled()
        expect(dialog.get_by_role('button',name='关闭',exact=True)).to_be_enabled()
        page.keyboard.press('Escape');expect(dialog).not_to_be_visible()
        page.get_by_role('button',name='编辑 ui-demo',exact=True).click()
        page.get_by_label('工具调用超时（毫秒）').fill('122000')
        assert len(held)==1
        held[0].continue_()
        page.wait_for_load_state('networkidle')
        expect(dialog).to_be_visible()
        expect(page.get_by_label('工具调用超时（毫秒）')).to_have_value('122000')
        page.unroute('**/api/mcp-manager.save')
        page.keyboard.press('Shift+Tab');page.keyboard.press('Shift+Tab')
        assert page.evaluate("!!document.activeElement.closest('[role=dialog]')")
        page.keyboard.press('Escape');expect(dialog).not_to_be_visible()
        expect(page.get_by_role('button',name='编辑 ui-demo',exact=True)).to_be_focused()
        page.get_by_role('button',name='查看工具',exact=True).click()
        expect(page.get_by_text('mcp__ui-demo__mix_content',exact=True)).to_be_visible()
        page.get_by_role('switch',name='停用工具 echo',exact=True).click()
        expect(page.get_by_role('switch',name='启用工具 echo',exact=True)).to_have_attribute('aria-checked','false')
        page.get_by_text('近期活动',exact=True).click()
        expect(page.locator('.dshmcp-log ol')).to_contain_text('Connected')
        page.get_by_role('button',name='复制 ui-demo',exact=True).click()
        expect(dialog.get_by_label('名称',exact=True)).to_have_value('ui-demo_copy1')
        dialog.get_by_role('button',name='保存',exact=True).click();expect(dialog).not_to_be_visible()
        page.get_by_role('searchbox').fill('copy1');expect(page.locator('.dshmcp-list>.dshmcp-row')).to_have_count(1)
        page.get_by_role('searchbox').fill('');page.get_by_label('按状态筛选').select_option('disabled')
        expect(page.locator('.dshmcp-list>.dshmcp-row')).to_have_count(1)
        page.get_by_label('按状态筛选').select_option('all')
        page.get_by_text('导入 / 导出配置',exact=True).click()
        page.get_by_role('button',name='导出配置',exact=True).click()
        page.wait_for_function("document.querySelector('.dshmcp-transfer textarea').value.includes('ui-demo')")
        exported=json.loads(page.get_by_label('JSON 配置',exact=True).input_value())
        assert len(exported['servers'])==2 and 'env' not in exported['servers'][0] and 'headers' not in exported['servers'][0]
        page.get_by_label('JSON 配置',exact=True).fill(json.dumps({'mcpServers':{'imported':{'command':'node'}}}))
        page.get_by_role('button',name='导入为停用的服务器').click()
        expect(page.get_by_role('status')).to_contain_text('已导入 1 个服务器')
        rail=page.get_by_role('switch',name='在左侧栏显示入口',exact=True)
        rail.click();expect(rail).to_have_attribute('aria-checked','false')
        rail.click();expect(rail).to_have_attribute('aria-checked','true')
        for width in [320,768,1024,1440]:
            page.set_viewport_size({'width':width,'height':900})
            page.screenshot(path=f'.qa/width-{width}.png',full_page=True)
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'overflow at {width}'
        page.get_by_role('button', name='删除 imported', exact=True).click()
        page.get_by_role('button', name='删除', exact=True).click()
        expect(page.get_by_role('button', name='删除 imported', exact=True)).not_to_be_visible()
        page.request.post('http://127.0.0.1:4199/__qa/corrupt')
        rail.click()
        page.get_by_role('button', name='刷新状态').click()
        expect(page.get_by_text('配置无法读取。为保留原文件，当前已锁定修改。')).to_be_visible()
        page.get_by_role('button', name='恢复上一次备份', exact=True).click()
        page.get_by_role('button', name='恢复上一次备份', exact=True).click()
        expect(page.get_by_text('配置无法读取。为保留原文件，当前已锁定修改。')).not_to_be_visible()
        assert not errors, errors
        print('Browser checks passed: CRUD, options, copy, filtering, tools, import/export, recovery, sidebar, focus, 4 widths; no React errors')
        browser.close()
finally:
    server.terminate()
    server.wait(timeout=10)
