import math
import random


def generate(data):
    # Parameterized per student (the Mustache values + the graded answer).
    h = random.choice([1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0])
    m = random.choice([1.0, 2.0, 3.0, 5.0])  # mass is a red herring (frictionless → v is independent of m)
    data["params"]["m"] = m
    data["params"]["h"] = h
    # Energy conservation: v = sqrt(2 g h).
    data["correct_answers"]["v"] = round(math.sqrt(2 * 9.8 * h), 3)
