"""Real public-callback integration of the explicitly named response guard."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
def driver():
    spec=importlib.util.spec_from_file_location('guard_driver',ROOT/'tools/fix-session/runtime/driver.py')
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

class ResponseGuardRuntimeTests(unittest.TestCase):
    def test_reported_guard_matches_effective_required_configuration(self):
        m=driver()
        with tempfile.TemporaryDirectory(dir='/state') as d,m.Lab(Path(d)) as lab:
            lab.start()
            for role in ('go','java'):
                self.assertEqual(lab.wait(role,'VERSION')['fields'].get('profile_guard'),'matching-testreq-v1')
                self.assertIn('TradeFlowResponseGuard=matching-testreq-v1',(Path(d)/(role+'.cfg')).read_text())

    def test_validated_matching_heartbeat_is_attributed_to_guard(self):
        m=driver()
        with tempfile.TemporaryDirectory(dir='/state') as d,m.Lab(Path(d)) as lab:
            lab.start()
            for role in ('go','java'):
                mark=lab.mark();lab.send(role,{'35':'1','112':'SYN-GUARD-MATCH'})
                acknowledged=lab.wait(role,'PROFILE_ACK',after=mark)
                self.assertEqual(acknowledged['fields']['112'],'SYN-GUARD-MATCH')

    def test_missing_or_wrong_guard_configuration_denied_before_listening(self):
        m=driver()
        for role,value in [(role,value) for role in ('go','java') for value in (None,'disabled')]:
            with self.subTest(role=role,value=value),tempfile.TemporaryDirectory(dir='/state') as d:
                lab=m.Lab(Path(d));cfg=lab._config(role)
                lines=[line for line in cfg.read_text().splitlines() if not line.startswith('TradeFlowResponseGuard=')]
                if value is not None:lines.append('TradeFlowResponseGuard='+value)
                cfg.write_text('\n'.join(lines)+'\n')
                args=['/opt/runtime/peer',str(cfg)] if role=='go' else ['/opt/java/openjdk/bin/java','-Xmx128m','-XX:ActiveProcessorCount=1','-cp','/opt/runtime/classes:/opt/runtime/lib/*','tradeflow.SessionMain',str(cfg)]
                result=subprocess.run(args,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env={'PATH':'/usr/bin:/bin','GOMAXPROCS':'1','GOMEMLIMIT':'128MiB'},timeout=10)
                self.assertEqual(result.returncode,2)
                self.assertIn(b'EVENT\tERROR\t',result.stdout)
                self.assertFalse((Path(d)/role).exists())

if __name__=='__main__':unittest.main()
