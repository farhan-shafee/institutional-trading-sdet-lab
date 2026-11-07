"""Profile admission boundaries; no invented engine response is asserted here."""
import importlib.util
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parents[2]
def driver():
    spec=importlib.util.spec_from_file_location('profile_driver',ROOT/'tools/fix-session/runtime/driver.py')
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

class TransportTests(unittest.TestCase):
    def setUp(self):
        self.m=driver();self.transport=self.m.FaultTransport(None)
        self.header={'35':'0','49':'TRADEFLOW','56':'ATLAS','34':'2','52':'20261107-14:00:00.000'}

    def test_selected_profile_rejects_unsupported_reset_identity_and_headers(self):
        cases=[
          ({'49':'OTHER'},'COMP_ID_MISMATCH'),
          ({'35':'Z'},'MESSAGE_UNSUPPORTED'),
          ({'35':'A','98':'0','108':'30','141':'Y'},'LOGON_PROFILE'),
          ({'35':'A','98':'0','108':'29'},'LOGON_PROFILE'),
          ({'35':'4','123':'N','36':'9'},'RESET_UNSUPPORTED'),
          ({'35':'4','123':'Y','36':'2'},'INVALID_GAP_FILL'),
          ({'43':'Y'},'REPLAY_HEADER'),
          ({'43':'Y','122':'20261107-14:00:00.001'},'REPLAY_HEADER'),
          ({'43':'N','122':'20261107-14:00:00.000'},'REPLAY_HEADER'),
          ({'52':'20261307-14:00:00.000'},'TIMESTAMP_FORMAT'),
          ({'35':'D','11':'SYN-1','9999':'unknown'},'FIELD_UNSUPPORTED'),
        ]
        for changes,expected in cases:
            with self.subTest(expected=expected,changes=changes):
                with self.assertRaisesRegex(self.m.LabError,'^'+expected+'$'):
                    self.transport.admit('J_TO_G',dict(self.header,**changes))

    def test_same_identity_with_changed_business_value_fails_closed(self):
        first=dict(self.header,**{'35':'D','11':'SYN-1','44':'100.050000000123','38':'100.00'})
        self.transport.admit('J_TO_G',first)
        same=dict(first,**{'34':'3','43':'Y','122':first['52']})
        self.transport.admit('J_TO_G',same)
        with self.assertRaisesRegex(self.m.LabError,'^DUPLICATE_CONFLICT$'):
            self.transport.admit('J_TO_G',dict(same,**{'44':'100.050000000124'}))

    def test_opposite_direction_compids_and_valid_gapfill(self):
        self.transport.admit('G_TO_J',dict(self.header,**{'49':'ATLAS','56':'TRADEFLOW'}))
        self.transport.admit('J_TO_G',dict(self.header,**{'35':'4','123':'Y','36':'3'}))

if __name__=='__main__':unittest.main()
