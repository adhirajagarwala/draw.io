import math
import random


def generate(data):
    # A charging RC circuit, parameterised per student. Deliberately long prose so the overlay,
    # notes positioning, snip, and tall-page growth get exercised on content that spans screens.
    v0 = random.choice([5.0, 9.0, 12.0, 15.0])       # source EMF (volts)
    r_k = random.choice([1.0, 2.2, 4.7, 10.0])       # resistance (kilo-ohms)
    c_uf = random.choice([1.0, 2.2, 4.7, 10.0])      # capacitance (micro-farads)
    data["params"]["v0"] = v0
    data["params"]["r_k"] = r_k
    data["params"]["c_uf"] = c_uf
    tau_ms = r_k * c_uf  # (kΩ)(µF) = ms
    data["params"]["tau_ms"] = round(tau_ms, 3)
    # Voltage across the capacitor after one time constant: V = V0 (1 - e^-1).
    data["correct_answers"]["vc"] = round(v0 * (1 - math.exp(-1.0)), 3)
