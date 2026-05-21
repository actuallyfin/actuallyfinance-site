const TAX_DATA_URL = "data/processed/tax_brackets_2026.csv";

const SUPPORTED_FILING_STATUSES = {
  single: "Single",
  married_filing_jointly: "Married filing jointly",
};

const ROTH_IRA_PHASEOUT_2026 = {
  single: [153000, 168000],
  married_filing_jointly: [242000, 252000],
};

const TRADITIONAL_IRA_DEDUCTION_PHASEOUT_2026 = {
  single_active: [81000, 91000],
  married_filing_jointly_active: [129000, 149000],
  married_filing_jointly_spouse_active: [242000, 252000],
};

const SOCIAL_SECURITY_WAGE_BASE_2026 = 184500;
const EMPLOYEE_SOCIAL_SECURITY_RATE = 0.062;
const EMPLOYEE_MEDICARE_RATE = 0.0145;
const ADDITIONAL_MEDICARE_RATE = 0.009;
const ADDITIONAL_MEDICARE_THRESHOLDS = {
  single: 200000,
  married_filing_jointly: 250000,
};

let taxRows = [];

const moneyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

function parseNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCsv(text) {
  const rows = [];
  let field = "";
  let row = [];
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  const headers = rows.shift();
  return rows.filter((item) => item.length === headers.length).map((item) => {
    const record = {};
    headers.forEach((header, index) => {
      record[header] = item[index];
    });
    return record;
  });
}

function normalizeTaxRows(rows) {
  const numericColumns = [
    "tax_year",
    "bracket_order",
    "bracket_lower",
    "bracket_upper",
    "rate",
    "standard_deduction_amount",
    "personal_exemption_amount",
    "dependent_exemption_amount",
  ];

  return rows.map((row) => {
    const normalized = { ...row };
    numericColumns.forEach((column) => {
      normalized[column] = parseNumber(row[column]);
    });
    return normalized;
  });
}

function availableStates(rows) {
  return [...new Set(rows
    .filter((row) => row.tax_type === "state_ordinary_income")
    .map((row) => row.jurisdiction))]
    .sort((a, b) => a.localeCompare(b));
}

function amountIfNotCredit(row, rawColumn, amountColumn) {
  const raw = String(row[rawColumn] || "").toLowerCase();
  if (raw.includes("credit") || ["", "nan", "n.a.", "n.a"].includes(raw)) return 0;
  return row[amountColumn] || 0;
}

function firstMetadataRow(brackets) {
  if (!brackets.length) {
    throw new Error("No bracket rows were found for this jurisdiction and filing status.");
  }
  return [...brackets].sort((a, b) => a.bracket_order - b.bracket_order)[0];
}

function calculateBracketTax(taxableIncome, brackets) {
  const income = Math.max(0, Number(taxableIncome) || 0);
  const ordered = [...brackets].sort((a, b) => a.bracket_lower - b.bracket_lower);
  let tax = 0;
  let marginalRate = 0;

  for (const row of ordered) {
    const lower = row.bracket_lower || 0;
    const upper = row.bracket_upper;
    const rate = row.rate || 0;

    if (income <= lower) break;

    const bracketTop = upper === null ? income : Math.min(income, upper);
    const taxedAmount = Math.max(0, bracketTop - lower);
    tax += taxedAmount * rate;

    if (income > lower) marginalRate = rate;
    if (upper !== null && income <= upper) break;
  }

  return { tax, marginalRate };
}

function calculateStackedCapitalGainsTax(ordinaryTaxableIncome, capitalGainsTaxableIncome, brackets) {
  const ordinary = Math.max(0, ordinaryTaxableIncome || 0);
  const gains = Math.max(0, capitalGainsTaxableIncome || 0);
  if (gains === 0) return { tax: 0, marginalRate: 0 };

  const totalTaxableIncome = ordinary + gains;
  let tax = 0;
  let marginalRate = 0;

  for (const row of [...brackets].sort((a, b) => a.bracket_lower - b.bracket_lower)) {
    const lower = row.bracket_lower || 0;
    const upper = row.bracket_upper;
    const rate = row.rate || 0;
    const bracketTop = upper === null ? totalTaxableIncome : Math.min(totalTaxableIncome, upper);
    const taxableStart = Math.max(lower, ordinary);
    const taxableEnd = Math.min(bracketTop, totalTaxableIncome);
    const taxedAmount = Math.max(0, taxableEnd - taxableStart);
    tax += taxedAmount * rate;
    if (taxedAmount > 0) marginalRate = rate;
    if (upper !== null && totalTaxableIncome <= upper) break;
  }

  return { tax, marginalRate };
}

function calculateJurisdictionTax({ jurisdictionCode, taxType, filingStatus, grossIncome, dependents = 0 }) {
  const brackets = taxRows.filter((row) => (
    row.jurisdiction_code === jurisdictionCode
    && row.tax_type === taxType
    && row.filing_status === filingStatus
  ));
  const meta = firstMetadataRow(brackets);
  const standardDeduction = amountIfNotCredit(meta, "standard_deduction_raw", "standard_deduction_amount");
  const personalExemption = amountIfNotCredit(meta, "personal_exemption_raw", "personal_exemption_amount");
  const dependentExemption = amountIfNotCredit(meta, "dependent_exemption_raw", "dependent_exemption_amount");
  const taxableIncome = Math.max(
    0,
    grossIncome - standardDeduction - personalExemption - dependentExemption * Math.max(0, dependents),
  );
  const { tax, marginalRate } = calculateBracketTax(taxableIncome, brackets);

  return {
    jurisdiction: meta.jurisdiction,
    taxableIncome,
    tax,
    effectiveRate: grossIncome > 0 ? tax / grossIncome : 0,
    marginalRate,
    standardDeduction,
    personalExemption,
    dependentExemption,
    ordinaryTaxableIncome: taxableIncome,
    longTermCapitalGainsTaxableIncome: 0,
    longTermCapitalGainsTax: 0,
    longTermCapitalGainsMarginalRate: 0,
  };
}

function calculateFederalIncomeTax({ filingStatus, grossIncome, longTermCapitalGainsIncome = 0, dependents = 0 }) {
  const ordinaryIncome = Math.max(0, grossIncome - longTermCapitalGainsIncome);
  const ordinaryBrackets = taxRows.filter((row) => (
    row.jurisdiction_code === "US"
    && row.tax_type === "federal_ordinary_income"
    && row.filing_status === filingStatus
  ));
  const capitalGainsBrackets = taxRows.filter((row) => (
    row.jurisdiction_code === "US"
    && row.tax_type === "federal_long_term_capital_gains"
    && row.filing_status === filingStatus
  ));
  const meta = firstMetadataRow(ordinaryBrackets);
  const standardDeduction = amountIfNotCredit(meta, "standard_deduction_raw", "standard_deduction_amount");
  const personalExemption = amountIfNotCredit(meta, "personal_exemption_raw", "personal_exemption_amount");
  const dependentExemption = amountIfNotCredit(meta, "dependent_exemption_raw", "dependent_exemption_amount");
  const totalDeductions = standardDeduction + personalExemption + dependentExemption * Math.max(0, dependents);
  const ordinaryTaxableIncome = Math.max(0, ordinaryIncome - totalDeductions);
  const unusedDeductions = Math.max(0, totalDeductions - ordinaryIncome);
  const longTermCapitalGainsTaxableIncome = Math.max(0, longTermCapitalGainsIncome - unusedDeductions);
  const ordinaryResult = calculateBracketTax(ordinaryTaxableIncome, ordinaryBrackets);
  const gainsResult = calculateStackedCapitalGainsTax(
    ordinaryTaxableIncome,
    longTermCapitalGainsTaxableIncome,
    capitalGainsBrackets,
  );
  const tax = ordinaryResult.tax + gainsResult.tax;
  const taxableIncome = ordinaryTaxableIncome + longTermCapitalGainsTaxableIncome;

  return {
    jurisdiction: "United States",
    taxableIncome,
    tax,
    effectiveRate: grossIncome > 0 ? tax / grossIncome : 0,
    marginalRate: ordinaryResult.marginalRate,
    standardDeduction,
    personalExemption,
    dependentExemption,
    ordinaryTaxableIncome,
    longTermCapitalGainsTaxableIncome,
    longTermCapitalGainsTax: gainsResult.tax,
    longTermCapitalGainsMarginalRate: gainsResult.marginalRate,
  };
}

function calculateEffectiveIncomeTaxRate({
  grossIncome,
  state,
  filingStatus,
  dependents = 0,
  longTermCapitalGainsPercent = 0,
}) {
  if (!SUPPORTED_FILING_STATUSES[filingStatus]) throw new Error(`Unsupported filing status: ${filingStatus}`);
  if (grossIncome < 0) throw new Error("Gross income cannot be negative.");

  const stateRows = taxRows.filter((row) => row.tax_type === "state_ordinary_income" && row.jurisdiction === state);
  if (!stateRows.length) throw new Error(`State not found in tax data: ${state}`);
  const stateCode = stateRows[0].jurisdiction_code;
  const longTermCapitalGainsIncome = grossIncome * Math.min(1, Math.max(0, longTermCapitalGainsPercent));
  const ordinaryIncome = grossIncome - longTermCapitalGainsIncome;
  const federal = calculateFederalIncomeTax({
    filingStatus,
    grossIncome,
    longTermCapitalGainsIncome,
    dependents,
  });
  const stateTax = calculateJurisdictionTax({
    jurisdictionCode: stateCode,
    taxType: "state_ordinary_income",
    filingStatus,
    grossIncome,
    dependents,
  });
  const stateCapitalGainsRows = taxRows.filter((row) => (
    row.jurisdiction_code === stateCode
    && row.tax_type === "state_capital_gains"
    && row.filing_status === filingStatus
  ));
  let stateCapitalGainsTax = null;
  let stateCapitalGainsTaxAmount = 0;

  if (longTermCapitalGainsIncome > 0 && stateCapitalGainsRows.length) {
    stateCapitalGainsTax = calculateJurisdictionTax({
      jurisdictionCode: stateCode,
      taxType: "state_capital_gains",
      filingStatus,
      grossIncome: longTermCapitalGainsIncome,
      dependents: 0,
    });
    stateCapitalGainsTaxAmount = stateCapitalGainsTax.tax;
  }

  const totalTax = federal.tax + stateTax.tax + stateCapitalGainsTaxAmount;
  return {
    grossIncome,
    ordinaryIncome,
    longTermCapitalGainsIncome,
    longTermCapitalGainsPercent,
    filingStatus,
    state,
    dependents,
    federal,
    stateTax,
    stateCapitalGainsTax,
    totalTax,
    combinedEffectiveRate: grossIncome > 0 ? totalTax / grossIncome : 0,
    combinedMarginalRate: federal.marginalRate + stateTax.marginalRate,
  };
}

function totalIncomeTax({ income, state, filingStatus, dependents, longTermCapitalGainsIncome = 0 }) {
  if (income <= 0) return 0;
  const ltcgPercent = income ? longTermCapitalGainsIncome / income : 0;
  return calculateEffectiveIncomeTaxRate({
    grossIncome: income,
    state,
    filingStatus,
    dependents,
    longTermCapitalGainsPercent: ltcgPercent,
  }).totalTax;
}

function incrementalOrdinaryTax({ baselineIncome, additionalOrdinaryIncome, state, filingStatus, dependents }) {
  if (additionalOrdinaryIncome <= 0) return 0;
  const baseTax = totalIncomeTax({ income: baselineIncome, state, filingStatus, dependents });
  const fullTax = totalIncomeTax({
    income: baselineIncome + additionalOrdinaryIncome,
    state,
    filingStatus,
    dependents,
  });
  return Math.max(0, fullTax - baseTax);
}

function ordinarySliceLowHighRates({ baselineIncome, additionalOrdinaryIncome, state, filingStatus, dependents }) {
  if (additionalOrdinaryIncome <= 0) return [0, 0];
  const lowIncrement = Math.min(1, additionalOrdinaryIncome);
  const highIncrement = Math.min(1, additionalOrdinaryIncome);
  const lowTax = incrementalOrdinaryTax({
    baselineIncome,
    additionalOrdinaryIncome: lowIncrement,
    state,
    filingStatus,
    dependents,
  });
  const highTax = incrementalOrdinaryTax({
    baselineIncome: baselineIncome + additionalOrdinaryIncome - highIncrement,
    additionalOrdinaryIncome: highIncrement,
    state,
    filingStatus,
    dependents,
  });
  return [Math.max(0, lowTax / lowIncrement), Math.max(0, highTax / highIncrement)];
}

function afterTaxOrdinaryIncome({ income, state, filingStatus, dependents }) {
  const tax = totalIncomeTax({ income, state, filingStatus, dependents });
  return Math.max(0, income - tax);
}

function solveBaselineForOrdinaryWithdrawal({
  grossWithdrawal,
  requiredAfterTaxIncome,
  state,
  filingStatus,
  dependents,
}) {
  if (grossWithdrawal <= 0) return [0, 0];

  const netIncomeWithWithdrawal = (baselineIncome) => {
    const withdrawalTax = incrementalOrdinaryTax({
      baselineIncome,
      additionalOrdinaryIncome: grossWithdrawal,
      state,
      filingStatus,
      dependents,
    });
    return afterTaxOrdinaryIncome({ income: baselineIncome, state, filingStatus, dependents })
      + grossWithdrawal
      - withdrawalTax;
  };

  let baselineIncome = 0;
  if (netIncomeWithWithdrawal(0) < requiredAfterTaxIncome) {
    let low = 0;
    let high = Math.max(requiredAfterTaxIncome * 2, grossWithdrawal * 2, 1);
    while (netIncomeWithWithdrawal(high) < requiredAfterTaxIncome) {
      high *= 2;
    }
    for (let index = 0; index < 60; index += 1) {
      const mid = (low + high) / 2;
      if (netIncomeWithWithdrawal(mid) < requiredAfterTaxIncome) low = mid;
      else high = mid;
    }
    baselineIncome = high;
  }

  const withdrawalTax = incrementalOrdinaryTax({
    baselineIncome,
    additionalOrdinaryIncome: grossWithdrawal,
    state,
    filingStatus,
    dependents,
  });
  return [baselineIncome, withdrawalTax];
}

function incrementalLongTermCapitalGainsTax({
  baselineOrdinaryIncome,
  additionalLongTermCapitalGains,
  state,
  filingStatus,
  dependents,
}) {
  if (additionalLongTermCapitalGains <= 0) return 0;
  const baseTax = totalIncomeTax({
    income: baselineOrdinaryIncome,
    state,
    filingStatus,
    dependents,
  });
  const fullTax = totalIncomeTax({
    income: baselineOrdinaryIncome + additionalLongTermCapitalGains,
    state,
    filingStatus,
    dependents,
    longTermCapitalGainsIncome: additionalLongTermCapitalGains,
  });
  return Math.max(0, fullTax - baseTax);
}

function longTermCapitalGainsSliceLowHighRates({
  baselineOrdinaryIncome,
  additionalLongTermCapitalGains,
  state,
  filingStatus,
  dependents,
}) {
  if (additionalLongTermCapitalGains <= 0) return [0, 0];
  const lowIncrement = Math.min(1, additionalLongTermCapitalGains);
  const highIncrement = Math.min(1, additionalLongTermCapitalGains);
  const lowTax = incrementalLongTermCapitalGainsTax({
    baselineOrdinaryIncome,
    additionalLongTermCapitalGains: lowIncrement,
    state,
    filingStatus,
    dependents,
  });
  const fullTax = incrementalLongTermCapitalGainsTax({
    baselineOrdinaryIncome,
    additionalLongTermCapitalGains,
    state,
    filingStatus,
    dependents,
  });
  const beforeHighTax = incrementalLongTermCapitalGainsTax({
    baselineOrdinaryIncome,
    additionalLongTermCapitalGains: additionalLongTermCapitalGains - highIncrement,
    state,
    filingStatus,
    dependents,
  });
  return [Math.max(0, lowTax / lowIncrement), Math.max(0, (fullTax - beforeHighTax) / highIncrement)];
}

function solveTaxableBrokerageWithdrawalForNet({
  accountValue,
  basis,
  requiredAfterTaxIncome,
  state,
  filingStatus,
  dependents,
}) {
  if (accountValue <= 0) return [0, 0, 0, requiredAfterTaxIncome];
  const gainRatio = Math.max(0, accountValue - basis) / accountValue;
  const taxableGain = accountValue * gainRatio;

  const netIncomeWithWithdrawal = (baselineIncome) => {
    const tax = incrementalLongTermCapitalGainsTax({
      baselineOrdinaryIncome: baselineIncome,
      additionalLongTermCapitalGains: taxableGain,
      state,
      filingStatus,
      dependents,
    });
    return afterTaxOrdinaryIncome({ income: baselineIncome, state, filingStatus, dependents })
      + accountValue
      - tax;
  };

  let baselineIncome = 0;
  if (netIncomeWithWithdrawal(0) < requiredAfterTaxIncome) {
    let low = 0;
    let high = Math.max(requiredAfterTaxIncome * 2, accountValue * 2, 1);
    while (netIncomeWithWithdrawal(high) < requiredAfterTaxIncome) {
      high *= 2;
    }
    for (let index = 0; index < 60; index += 1) {
      const mid = (low + high) / 2;
      if (netIncomeWithWithdrawal(mid) < requiredAfterTaxIncome) low = mid;
      else high = mid;
    }
    baselineIncome = high;
  }

  const tax = incrementalLongTermCapitalGainsTax({
    baselineOrdinaryIncome: baselineIncome,
    additionalLongTermCapitalGains: taxableGain,
    state,
    filingStatus,
    dependents,
  });
  return [accountValue, tax, taxableGain, baselineIncome];
}

function phaseoutFraction(income, lower, upper) {
  if (income <= lower) return 1;
  if (income >= upper) return 0;
  return (upper - income) / (upper - lower);
}

function rothIraEligibilityNote(income, filingStatus) {
  const limits = ROTH_IRA_PHASEOUT_2026[filingStatus];
  if (!limits) return "Roth IRA income phaseout not modeled for this filing status.";
  const [lower, upper] = limits;
  if (income <= lower) return "Direct Roth IRA contribution appears income-eligible.";
  if (income < upper) return "Direct Roth IRA contribution may be partially income-limited.";
  return "Direct Roth IRA contribution appears income-ineligible; backdoor Roth not modeled.";
}

function traditionalIraDeductionFraction(income, filingStatus, coveredByWorkplacePlan, spouseCoveredByWorkplacePlan) {
  if (!coveredByWorkplacePlan && !spouseCoveredByWorkplacePlan) return 1;
  if (filingStatus === "single" && coveredByWorkplacePlan) {
    return phaseoutFraction(income, ...TRADITIONAL_IRA_DEDUCTION_PHASEOUT_2026.single_active);
  }
  if (filingStatus === "married_filing_jointly" && coveredByWorkplacePlan) {
    return phaseoutFraction(income, ...TRADITIONAL_IRA_DEDUCTION_PHASEOUT_2026.married_filing_jointly_active);
  }
  if (filingStatus === "married_filing_jointly" && spouseCoveredByWorkplacePlan) {
    return phaseoutFraction(income, ...TRADITIONAL_IRA_DEDUCTION_PHASEOUT_2026.married_filing_jointly_spouse_active);
  }
  return 0;
}

function traditionalIraEligibilityNote(deductionFraction) {
  if (deductionFraction >= 0.999) return "Traditional IRA contribution appears fully deductible under the modeled inputs.";
  if (deductionFraction > 0) return "Traditional IRA deduction appears partially income-limited.";
  return "Traditional IRA deduction appears income-ineligible; modeled as nondeductible basis plus taxable earnings.";
}

function futureValue(amount, years, annualReturn, annualExpense = 0) {
  const netReturn = annualReturn - annualExpense;
  return amount * ((1 + netReturn) ** Math.max(0, years));
}

function incomeTaxSavingsFromDeduction({ currentIncome, deduction, state, filingStatus, dependents }) {
  if (deduction <= 0) return 0;
  const before = totalIncomeTax({ income: currentIncome, state, filingStatus, dependents });
  const after = totalIncomeTax({
    income: Math.max(0, currentIncome - deduction),
    state,
    filingStatus,
    dependents,
  });
  return Math.max(0, before - after);
}

function hsaPayrollTaxSavings({ wageIncomeBeforeContribution, contribution, filingStatus }) {
  const wageIncomeAfterContribution = Math.max(0, wageIncomeBeforeContribution - contribution);
  const socialSecurityBefore = Math.min(wageIncomeBeforeContribution, SOCIAL_SECURITY_WAGE_BASE_2026);
  const socialSecurityAfter = Math.min(wageIncomeAfterContribution, SOCIAL_SECURITY_WAGE_BASE_2026);
  const socialSecuritySavings = (socialSecurityBefore - socialSecurityAfter) * EMPLOYEE_SOCIAL_SECURITY_RATE;
  const medicareSavings = contribution * EMPLOYEE_MEDICARE_RATE;
  const additionalMedicareThreshold = ADDITIONAL_MEDICARE_THRESHOLDS[filingStatus];
  let additionalMedicareSavings = 0;
  if (additionalMedicareThreshold !== undefined) {
    const additionalBefore = Math.max(0, wageIncomeBeforeContribution - additionalMedicareThreshold);
    const additionalAfter = Math.max(0, wageIncomeAfterContribution - additionalMedicareThreshold);
    additionalMedicareSavings = (additionalBefore - additionalAfter) * ADDITIONAL_MEDICARE_RATE;
  }
  return Math.max(0, socialSecuritySavings + medicareSavings + additionalMedicareSavings);
}

function incomeTaxCostOnIncomeSlice({ currentIncome, incomeSlice, state, filingStatus, dependents }) {
  if (incomeSlice <= 0) return 0;
  const before = totalIncomeTax({
    income: Math.max(0, currentIncome - incomeSlice),
    state,
    filingStatus,
    dependents,
  });
  const after = totalIncomeTax({ income: currentIncome, state, filingStatus, dependents });
  return Math.max(0, after - before);
}

function optimizeIncrementalRetirementDollar(inputs) {
  const years = Math.max(0, inputs.withdrawalAge - inputs.currentAge);
  const iraDeductionFraction = traditionalIraDeductionFraction(
    inputs.currentIncome,
    inputs.filingStatus,
    inputs.coveredByWorkplacePlan,
    inputs.spouseCoveredByWorkplacePlan,
  );
  const results = [];
  const contributionBaselineIncome = Math.max(0, inputs.currentIncome - inputs.pretaxBudget);
  const currentIncomeTaxOnBudget = incomeTaxCostOnIncomeSlice({
    currentIncome: inputs.currentIncome,
    incomeSlice: inputs.pretaxBudget,
    state: inputs.currentState,
    filingStatus: inputs.filingStatus,
    dependents: inputs.dependents,
  });
  const [contributionIncomeLowRate, contributionIncomeHighRate] = ordinarySliceLowHighRates({
    baselineIncome: contributionBaselineIncome,
    additionalOrdinaryIncome: inputs.pretaxBudget,
    state: inputs.currentState,
    filingStatus: inputs.filingStatus,
    dependents: inputs.dependents,
  });
  const payrollTaxOnBudget = hsaPayrollTaxSavings({
    wageIncomeBeforeContribution: inputs.currentIncome,
    contribution: inputs.pretaxBudget,
    filingStatus: inputs.filingStatus,
  });
  const afterTaxBudget = Math.max(0, inputs.pretaxBudget - currentIncomeTaxOnBudget - payrollTaxOnBudget);
  const payrollTaxRateOnBudget = inputs.pretaxBudget ? payrollTaxOnBudget / inputs.pretaxBudget : 0;
  const taxableContributionLowRate = contributionIncomeLowRate + payrollTaxRateOnBudget;
  const taxableContributionHighRate = contributionIncomeHighRate + payrollTaxRateOnBudget;

  const addCommonFields = (row) => {
    const isUnavailable = row.futureValueAfterTax === null;
    const enriched = {
      ...row,
      pretaxIncomeContributionToday: inputs.pretaxBudget,
      postTaxContributionToday: row.contributionToday,
      contributionEffectiveTaxRate: inputs.pretaxBudget
        ? (inputs.pretaxBudget - row.contributionToday) / inputs.pretaxBudget
        : 0,
      withdrawalEffectiveTaxRate: row.futureValueBeforeTax
        ? row.taxDueAtWithdrawal / row.futureValueBeforeTax
        : 0,
      futureValueNoFeesOrTaxes: futureValue(inputs.pretaxBudget, years, inputs.annualReturn, 0),
      yearsToWithdrawal: years,
    };
    enriched.totalFeesAndTaxImpact = isUnavailable
      ? null
      : Math.max(0, enriched.futureValueNoFeesOrTaxes - enriched.futureValueAfterTax);
    enriched.totalFeesAndTaxImpactPct = isUnavailable
      ? null
      : (enriched.futureValueNoFeesOrTaxes ? enriched.totalFeesAndTaxImpact / enriched.futureValueNoFeesOrTaxes : 0);
    enriched.netTotalGrowthPct = isUnavailable
      ? null
      : (inputs.pretaxBudget ? (enriched.futureValueAfterTax / inputs.pretaxBudget) - 1 : 0);
    enriched.netAnnualizedGrowthPct = isUnavailable
      ? null
      : (years > 0 && inputs.pretaxBudget > 0
        ? ((enriched.futureValueAfterTax / inputs.pretaxBudget) ** (1 / years)) - 1
        : enriched.netTotalGrowthPct);
    return enriched;
  };

  const rothIraContribution = afterTaxBudget;
  const rothIraFv = futureValue(rothIraContribution, years, inputs.annualReturn, inputs.retirementAccountExpense);
  results.push(addCommonFields({
    account: "Roth IRA",
    contributionToday: rothIraContribution,
    futureValueBeforeTax: rothIraFv,
    futureValueAfterTax: rothIraFv,
    taxDueAtWithdrawal: 0,
    currentTaxSavings: 0,
    eligibilityNote: rothIraEligibilityNote(inputs.currentIncome, inputs.filingStatus),
    assumptions: "After-tax contribution; qualified withdrawal tax-free.",
    contributionLowestEffectiveTaxRate: taxableContributionLowRate,
    contributionHighestEffectiveTaxRate: taxableContributionHighRate,
    withdrawalLowestEffectiveTaxRate: 0,
    withdrawalHighestEffectiveTaxRate: 0,
  }));

  const tradIraTaxableSlice = inputs.pretaxBudget * (1 - iraDeductionFraction);
  const tradIraTaxCost = incomeTaxCostOnIncomeSlice({
    currentIncome: inputs.currentIncome,
    incomeSlice: tradIraTaxableSlice,
    state: inputs.currentState,
    filingStatus: inputs.filingStatus,
    dependents: inputs.dependents,
  });
  const tradIraContribution = Math.max(0, inputs.pretaxBudget - payrollTaxOnBudget - tradIraTaxCost);
  const tradIraTaxSavings = Math.max(0, currentIncomeTaxOnBudget - tradIraTaxCost);
  const tradIraFv = futureValue(tradIraContribution, years, inputs.annualReturn, inputs.retirementAccountExpense);
  const nondeductibleBasis = tradIraContribution * (1 - iraDeductionFraction);
  const tradIraTaxableWithdrawal = Math.max(0, tradIraFv - nondeductibleBasis);
  const [tradIraBaseline, tradIraWithdrawalTax] = solveBaselineForOrdinaryWithdrawal({
    grossWithdrawal: tradIraTaxableWithdrawal,
    requiredAfterTaxIncome: inputs.retirementIncome,
    state: inputs.retirementState,
    filingStatus: inputs.filingStatus,
    dependents: inputs.dependents,
  });
  const tradIraRates = ordinarySliceLowHighRates({
    baselineIncome: tradIraBaseline,
    additionalOrdinaryIncome: tradIraTaxableWithdrawal,
    state: inputs.retirementState,
    filingStatus: inputs.filingStatus,
    dependents: inputs.dependents,
  });
  if (nondeductibleBasis > 0) tradIraRates[0] = 0;
  results.push(addCommonFields({
    account: "Traditional IRA",
    contributionToday: tradIraContribution,
    futureValueBeforeTax: tradIraFv,
    futureValueAfterTax: tradIraFv - tradIraWithdrawalTax,
    taxDueAtWithdrawal: tradIraWithdrawalTax,
    currentTaxSavings: tradIraTaxSavings,
    eligibilityNote: traditionalIraEligibilityNote(iraDeductionFraction),
    assumptions: "Deductible portion gets current tax benefit; nondeductible basis is not taxed again.",
    contributionLowestEffectiveTaxRate: taxableContributionLowRate * (1 - iraDeductionFraction),
    contributionHighestEffectiveTaxRate: taxableContributionHighRate * (1 - iraDeductionFraction),
    withdrawalLowestEffectiveTaxRate: tradIraRates[0],
    withdrawalHighestEffectiveTaxRate: tradIraRates[1],
  }));

  const roth401kContribution = afterTaxBudget;
  const roth401kFv = futureValue(
    roth401kContribution,
    years,
    inputs.annualReturn,
    inputs.retirementAccountExpense + inputs.employerPlanExtraExpense,
  );
  results.push(addCommonFields({
    account: "Roth 401k",
    contributionToday: roth401kContribution,
    futureValueBeforeTax: roth401kFv,
    futureValueAfterTax: inputs.has401k ? roth401kFv : null,
    taxDueAtWithdrawal: 0,
    currentTaxSavings: 0,
    eligibilityNote: inputs.has401k ? "Requires access to a Roth 401k plan." : "Not modeled as available: no 401k access selected.",
    assumptions: "After-tax contribution; qualified withdrawal tax-free.",
    contributionLowestEffectiveTaxRate: taxableContributionLowRate,
    contributionHighestEffectiveTaxRate: taxableContributionHighRate,
    withdrawalLowestEffectiveTaxRate: 0,
    withdrawalHighestEffectiveTaxRate: 0,
  }));

  const trad401kContribution = Math.max(0, inputs.pretaxBudget - payrollTaxOnBudget);
  const trad401kFv = futureValue(
    trad401kContribution,
    years,
    inputs.annualReturn,
    inputs.retirementAccountExpense + inputs.employerPlanExtraExpense,
  );
  const [trad401kBaseline, trad401kWithdrawalTax] = solveBaselineForOrdinaryWithdrawal({
    grossWithdrawal: trad401kFv,
    requiredAfterTaxIncome: inputs.retirementIncome,
    state: inputs.retirementState,
    filingStatus: inputs.filingStatus,
    dependents: inputs.dependents,
  });
  const trad401kRates = ordinarySliceLowHighRates({
    baselineIncome: trad401kBaseline,
    additionalOrdinaryIncome: trad401kFv,
    state: inputs.retirementState,
    filingStatus: inputs.filingStatus,
    dependents: inputs.dependents,
  });
  results.push(addCommonFields({
    account: "Traditional 401k",
    contributionToday: trad401kContribution,
    futureValueBeforeTax: trad401kFv,
    futureValueAfterTax: inputs.has401k ? trad401kFv - trad401kWithdrawalTax : null,
    taxDueAtWithdrawal: trad401kWithdrawalTax,
    currentTaxSavings: currentIncomeTaxOnBudget,
    eligibilityNote: inputs.has401k ? "Requires access to a traditional 401k plan." : "Not modeled as available: no 401k access selected.",
    assumptions: "Pre-tax contribution; withdrawal taxed as ordinary income.",
    contributionLowestEffectiveTaxRate: payrollTaxRateOnBudget,
    contributionHighestEffectiveTaxRate: payrollTaxRateOnBudget,
    withdrawalLowestEffectiveTaxRate: trad401kRates[0],
    withdrawalHighestEffectiveTaxRate: trad401kRates[1],
  }));

  const hsaPayrollSavings = inputs.hsaPayrollContribution ? payrollTaxOnBudget : 0;
  const hsaContribution = inputs.hsaPayrollContribution
    ? inputs.pretaxBudget
    : Math.max(0, inputs.pretaxBudget - payrollTaxOnBudget);
  const hsaFv = futureValue(
    hsaContribution,
    years,
    inputs.annualReturn,
    inputs.retirementAccountExpense + inputs.hsaExtraExpense,
  );
  const [hsaBaseline, hsaWithdrawalTax] = solveBaselineForOrdinaryWithdrawal({
    grossWithdrawal: hsaFv,
    requiredAfterTaxIncome: inputs.retirementIncome,
    state: inputs.retirementState,
    filingStatus: inputs.filingStatus,
    dependents: inputs.dependents,
  });
  const hsaRates = ordinarySliceLowHighRates({
    baselineIncome: hsaBaseline,
    additionalOrdinaryIncome: hsaFv,
    state: inputs.retirementState,
    filingStatus: inputs.filingStatus,
    dependents: inputs.dependents,
  });
  const hsaContributionRate = inputs.hsaPayrollContribution ? 0 : payrollTaxRateOnBudget;
  results.push(addCommonFields({
    account: "HSA",
    contributionToday: hsaContribution,
    futureValueBeforeTax: hsaFv,
    futureValueAfterTax: inputs.hasHsa ? hsaFv - hsaWithdrawalTax : null,
    taxDueAtWithdrawal: hsaWithdrawalTax,
    currentTaxSavings: currentIncomeTaxOnBudget + hsaPayrollSavings,
    eligibilityNote: inputs.hasHsa ? "Requires HSA eligibility." : "Not modeled as available: HSA eligibility not selected.",
    assumptions: "Payroll HSA contributions get automatic FICA savings when selected; nonmedical distribution after age 65 is taxed as ordinary income with no penalty.",
    contributionLowestEffectiveTaxRate: hsaContributionRate,
    contributionHighestEffectiveTaxRate: hsaContributionRate,
    withdrawalLowestEffectiveTaxRate: hsaRates[0],
    withdrawalHighestEffectiveTaxRate: hsaRates[1],
  }));

  const taxableContribution = afterTaxBudget;
  const taxableFv = futureValue(
    taxableContribution,
    years,
    inputs.annualReturn,
    inputs.taxableAnnualTaxDrag + inputs.retirementAccountExpense,
  );
  const [, taxableFinalTax, taxableGainWithdrawn, taxableBaselineIncome] = solveTaxableBrokerageWithdrawalForNet({
    accountValue: taxableFv,
    basis: taxableContribution,
    requiredAfterTaxIncome: inputs.retirementIncome,
    state: inputs.retirementState,
    filingStatus: inputs.filingStatus,
    dependents: inputs.dependents,
  });
  const taxableRates = longTermCapitalGainsSliceLowHighRates({
    baselineOrdinaryIncome: taxableBaselineIncome,
    additionalLongTermCapitalGains: taxableGainWithdrawn,
    state: inputs.retirementState,
    filingStatus: inputs.filingStatus,
    dependents: inputs.dependents,
  });
  if (taxableContribution > 0) taxableRates[0] = 0;
  results.push(addCommonFields({
    account: "Taxable brokerage",
    contributionToday: taxableContribution,
    futureValueBeforeTax: taxableFv,
    futureValueAfterTax: taxableFv - taxableFinalTax,
    taxDueAtWithdrawal: taxableFinalTax,
    currentTaxSavings: 0,
    eligibilityNote: "No account-specific eligibility restriction modeled.",
    assumptions: "After-tax contribution; final unrealized gain taxed as long-term capital gain.",
    contributionLowestEffectiveTaxRate: taxableContributionLowRate,
    contributionHighestEffectiveTaxRate: taxableContributionHighRate,
    withdrawalLowestEffectiveTaxRate: taxableRates[0],
    withdrawalHighestEffectiveTaxRate: taxableRates[1],
  }));

  const ranked = [...results].sort((a, b) => {
    const aValue = a.futureValueAfterTax === null ? -Infinity : a.futureValueAfterTax;
    const bValue = b.futureValueAfterTax === null ? -Infinity : b.futureValueAfterTax;
    if (bValue !== aValue) return bValue - aValue;
    return a.account.localeCompare(b.account);
  });
  ranked.forEach((row, index) => {
    row.rank = index + 1;
  });
  return ranked;
}

function valueFromNumber(id) {
  const value = Number(document.getElementById(id).value);
  return Number.isFinite(value) ? value : 0;
}

function getInputs() {
  return {
    currentIncome: valueFromNumber("current-income"),
    retirementIncome: valueFromNumber("retirement-income"),
    currentState: document.getElementById("current-state").value,
    retirementState: document.getElementById("retirement-state").value,
    filingStatus: document.getElementById("filing-status").value,
    dependents: Math.max(0, Math.trunc(valueFromNumber("dependents"))),
    currentAge: Math.max(0, Math.trunc(valueFromNumber("current-age"))),
    withdrawalAge: Math.max(0, Math.trunc(valueFromNumber("withdrawal-age"))),
    pretaxBudget: valueFromNumber("pretax-budget"),
    annualReturn: valueFromNumber("annual-return") / 100,
    retirementAccountExpense: valueFromNumber("base-expense") / 100,
    employerPlanExtraExpense: valueFromNumber("extra-401k-expense") / 100,
    taxableAnnualTaxDrag: valueFromNumber("taxable-drag") / 100,
    hsaExtraExpense: valueFromNumber("extra-hsa-expense") / 100,
    hsaPayrollContribution: document.getElementById("hsa-payroll").checked,
    coveredByWorkplacePlan: document.getElementById("workplace-plan").checked,
    spouseCoveredByWorkplacePlan: document.getElementById("spouse-workplace-plan").checked,
    has401k: document.getElementById("has-401k").checked,
    hasHsa: document.getElementById("has-hsa").checked,
  };
}

function formatMoney(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "Not available";
  return moneyFormatter.format(value);
}

function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "Not available";
  return `${(value * 100).toFixed(2)}%`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderResults() {
  const table = document.getElementById("results-table");
  const topAccount = document.getElementById("top-account");
  const footnotes = document.getElementById("footnotes");

  try {
    const results = optimizeIncrementalRetirementDollar(getInputs());
    const hasTraditionalFootnote = results.some((row) => (
      row.account === "Traditional IRA"
      && row.eligibilityNote.toLowerCase().includes("income-ineligible")
    ));

    const accountLabels = results.map((row) => {
      if (row.account === "Traditional IRA" && hasTraditionalFootnote) return "Traditional IRA<sup>1</sup>";
      return escapeHtml(row.account);
    });

    const metrics = [
      ["Rank", (row) => String(row.rank), "rank-row"],
      ["Available after withdrawal", (row) => formatMoney(row.futureValueAfterTax)],
      ["Pretax contribution today", (row) => formatMoney(row.pretaxIncomeContributionToday)],
      ["Post-tax contribution today", (row) => formatMoney(row.postTaxContributionToday)],
      ["Contribution effective tax rate", (row) => formatPercent(row.contributionEffectiveTaxRate)],
      ["Contribution lowest effective tax rate", (row) => formatPercent(row.contributionLowestEffectiveTaxRate)],
      ["Contribution highest effective tax rate", (row) => formatPercent(row.contributionHighestEffectiveTaxRate)],
      ["Current tax savings", (row) => formatMoney(row.currentTaxSavings)],
      ["Future value before tax", (row) => formatMoney(row.futureValueBeforeTax)],
      ["Tax due at withdrawal", (row) => formatMoney(row.taxDueAtWithdrawal)],
      ["Future value after tax", (row) => formatMoney(row.futureValueAfterTax)],
      ["Withdrawal effective tax rate", (row) => formatPercent(row.withdrawalEffectiveTaxRate)],
      ["Withdrawal lowest effective tax rate", (row) => formatPercent(row.withdrawalLowestEffectiveTaxRate)],
      ["Withdrawal highest effective tax rate", (row) => formatPercent(row.withdrawalHighestEffectiveTaxRate)],
      ["Total fees and tax impact", (row) => formatMoney(row.totalFeesAndTaxImpact)],
      ["Total fees and tax impact %", (row) => formatPercent(row.totalFeesAndTaxImpactPct)],
      ["Net total growth %", (row) => formatPercent(row.netTotalGrowthPct)],
      ["Net annualized growth %", (row) => formatPercent(row.netAnnualizedGrowthPct)],
      ["Eligibility note", (row) => escapeHtml(row.eligibilityNote), "", "note-cell"],
      ["Modeled assumptions", (row) => escapeHtml(row.assumptions), "", "note-cell"],
    ];

    const header = `<thead><tr><th>Metric</th>${accountLabels.map((label) => `<th>${label}</th>`).join("")}</tr></thead>`;
    const body = metrics.map(([name, formatter, rowClass = "", cellClass = ""]) => (
      `<tr class="${rowClass}"><td>${escapeHtml(name)}</td>${results.map((row) => {
        const unavailable = row.futureValueAfterTax === null && name === "Available after withdrawal";
        const classNames = [cellClass, unavailable ? "unavailable" : ""].filter(Boolean).join(" ");
        return `<td class="${classNames}">${formatter(row)}</td>`;
      }).join("")}</tr>`
    )).join("");

    table.innerHTML = `${header}<tbody>${body}</tbody>`;
    const best = results.find((row) => row.futureValueAfterTax !== null);
    topAccount.textContent = best ? `${best.account}: ${formatMoney(best.futureValueAfterTax)}` : "No available account";
    footnotes.innerHTML = hasTraditionalFootnote
      ? "<p><sup>1</sup> Traditional IRA deduction appears income-ineligible under these inputs, so the model treats the contribution as nondeductible basis with taxable growth.</p>"
      : "";
  } catch (error) {
    table.innerHTML = `<tbody><tr><td>Error</td><td>${escapeHtml(error.message)}</td></tr></tbody>`;
    topAccount.textContent = "Check inputs";
    footnotes.innerHTML = "";
  }
}

function populateStateSelects() {
  const states = availableStates(taxRows);
  const options = states.map((state) => `<option value="${escapeHtml(state)}">${escapeHtml(state)}</option>`).join("");
  const currentState = document.getElementById("current-state");
  const retirementState = document.getElementById("retirement-state");
  currentState.innerHTML = options;
  retirementState.innerHTML = options;
  currentState.value = states.includes("Minnesota") ? "Minnesota" : states[0];
  retirementState.value = states.includes("Minnesota") ? "Minnesota" : states[0];
}

async function init() {
  const response = await fetch(TAX_DATA_URL);
  if (!response.ok) throw new Error(`Could not load tax data: ${response.status}`);
  taxRows = normalizeTaxRows(parseCsv(await response.text()));
  populateStateSelects();
  document.getElementById("optimizer-form").addEventListener("input", renderResults);
  document.getElementById("optimizer-form").addEventListener("change", renderResults);
  renderResults();
}

init().catch((error) => {
  document.getElementById("top-account").textContent = "Tax data failed to load";
  document.getElementById("results-table").innerHTML = `<tbody><tr><td>Error</td><td>${escapeHtml(error.message)}</td></tr></tbody>`;
});
